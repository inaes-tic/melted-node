var net       = require('net')
,   Q         = require('q')
,   moment    = require('moment')
,   semaphore = require('semaphore')
,   winston   = require('winston')
,   events    = require('events')
,   util     = require('util')
;

var instance_counter = 0;

function melted_node(host, port, logger, timeout) {
    this.server     = false;  // connection to melted
    this.errors     = [];     // error messages returned by melted
    this.pending    = [];     // commands not yet sent to melted
    this.connected  = false;  // true if connection to server has been established
    this.commands   = [];     // commands already sent to melted, awaiting response
    this.connects   = semaphore(1);  // manages connection access (for use with .connect and .disconnect)
    this.response   = '';     // received response text still unprocessed
    this.started    = false;  // true if connection workflow has started
    this.timeout    = timeout || 2000;     // timeout time
    this.timer      = undefined;           // the timer for response timeout
    this.host       = host || 'localhost'; // melted host address
    this.port       = port || 5250;        // melted port address
    this._logger     = logger || new (winston.Logger)({
        transports: [
            new winston.transports.Console({
                colorize: true,
                level: 'info',
                timestamp: true
            }),
            new (winston.transports.File)({
                filename: './logs/melted-node.log',
                handleExceptions: true,
                level: 'debug',
                timestamp: true,
                json: false,
                maxsize: 1024000,
                maxFiles: 5
            })
        ],
        exitOnError: false
    });
    this._instance = instance_counter++;
    var self = this;
    this.logger = {
        _getArguments: function(args) {
            var args = Array.prototype.slice.call(args);
            args[0] = self._instance + ": " + args[0];
            return args;
        },
        error: function() {
            var args = this._getArguments(arguments);
            self._logger.error.apply(self._logger, args);
        },
        warn: function() {
            var args = this._getArguments(arguments);
            self._logger.warn.apply(self._logger, args);
        },
        info: function() {
            var args = this._getArguments(arguments);
            self._logger.info.apply(self._logger, args);
        },
        debug: function() {
            var args = this._getArguments(arguments);
            self._logger.debug.apply(self._logger, args);
        },
    };
    events.EventEmitter.call(this);
    this.on('response-timeout', this.responseTimeout.bind(this));
};

util.inherits(melted_node, events.EventEmitter);

melted_node.prototype.responseTimeout = function() {
    var error = new Error("Melted Server connection timed out");
    this.logger.error(error.message);
    if (this.connected)
        this.server.end();
};

melted_node.prototype.setTimer = function() {
    if(this.timer)
        this.cancelTimer();
    this.logger.debug('setting timer for %d milliseconds', this.timeout);
    this.timer = setTimeout((function() {
        this.emit('response-timeout');
    }).bind(this), this.timeout);
};

melted_node.prototype.cancelTimer = function() {
    this.logger.debug('canceling timer');
    clearTimeout(this.timer);
    this.timer = undefined;
};

melted_node.prototype.dataReceived = function(data) {
    this.logger.info("[dataReceived] Got: " + data.length + " bytes");
    this.logger.debug("[dataReceived] received data: " + data);
    this.response += data;
    this.setTimer();
};

melted_node.prototype.sendResponse = function(response, reject) {
    var command = this.commands.shift();
    this.logger.debug("responding to %s (reject: %s)", command[0], reject);
    if(reject) {
        this.emit('command-error', response, command[0]);
        command[1].reject(response);
    } else {
        this.emit('command-response', response, command[0]);
        command[1].resolve(response);
    }
};

melted_node.prototype.processResponse = function() {
    this.logger.info('[processResponse] try to process response');
    this.logger.debug('[processResponse] response to process: "%s"', this.response);
    this.logger.debug("pending commands length: %d", this.commands.length);
    if(this.response.length && !this.commands.length) {
        this.logger.warn("I got a response, but no pending commands. I'll ignore it");
        this.response = '';
    }
    if(!this.commands.length) {
        // nothing to do
        this.logger.info("[processResponse] no pending commands");
        return;
    }
    var spl = this.response.split("\r\n", 2);
    this.logger.debug("splitted length: %d", spl.length);
    if(spl[1] === undefined) {
        // no newlines yet, wait for next packet
        this.logger.info("[processResponse] status line not completely received yet");
        return;
    }

    var status = spl[0];
    this.logger.debug("Processing status: %s", status);

    var com = this.commands[0];
    this.logger.info('[processResponse] processing response for command "%s"', com[0]);
    var deferred = com[1];
    var cont = false;
    if(status == "200 OK") {
        // Just an OK message.
        this.logger.debug("it's an OK");
        this.response = this.response.substr(status.length + 2);
        this.sendResponse(status);
        cont = true;
    } else if(status == "201 OK") {
        this.logger.debug("multi-lined response");
        // multi-lined response. wait for "\r\n\r\n"
        var splitted = this.response.split("\r\n\r\n");
        if(splitted[1] !== undefined) {
            this.logger.debug("multi-lined response is ready");
            // "201 OK\r\nfoo\r\n\r\n".split("\r\n\r\n") ==> ['201 OK\r\nfoo', ''], so ...split(..)[1] === undefined is false
            var ret = splitted[0];
            this.response = splitted.slice(1).join("\r\n\r\n");
            this.sendResponse(ret);
            cont = true;
        } else {
            this.logger.debug("multi-lined response is not ready yet");
        }
    } else if(status == "202 OK") {
        this.logger.debug("single-lined response");
        // one-line response. wait for "\r\n"
        var splitted = this.response.split("\r\n");
        if(splitted[2] !== undefined) {
            this.logger.debug("single-lined response is ready");
            // "202 OK\r\nfoo\r\n".split("\r\n") ==> ['202 OK', 'foo', ''], so ...split(..)[2] === undefined is false
            // so I've got the whole response
            var ret = splitted.slice(0, 2);  // ['202 OK', 'foo']
            // re-join the rest of the buffer
            this.response = splitted.slice(2).join("\r\n");
            /* so in the case we had "202 OK\r\nfoo\r\nbar", this will become "bar".
               IF we had "202 OK\r\nfoo\r\n\r\n", this will become "\r\n",
               but this should *not* happen. In any case, the "header" of the
               next response will not be recognized and will be dropped, so the
               process won't brake (but a warning will be logged
            */
            this.sendResponse(ret.join("\r\n")); // "202 OK\r\nfoo" (drops the final \r\n)
            cont = true;
        } else {
            this.logger.debug("single-lined response is not ready yet");
        }
    } else if(status.match(/^[45][0-9][0-9]/)) {
        // we've got an error
        this.logger.warn("[processResponse] I got an error: %s", status);
        this.errors.push(status);
        this.response = this.response.substr(status.length + 2);
        this.sendResponse(new Error(status), true);
        cont = true;
    } else {
        // I don't know what we have here, but we're never going to be able to process it. Lose it
        this.logger.warn("I got an unknown beginning of response. I'm ignoring it: \"%s\"", status);
        // drop the offending line
        this.response = this.response.substr(status.length + 2);
        cont = true;
    }

    this.logger.debug("if cont(%s) and response(%d), continue", ''+cont, this.response.length);
    // if we processed something and still have data to process, have another go
    if(cont && this.response) {
        this.logger.debug("calling processResponse again");
        setTimeout(this.processResponse.bind(this), 0);
    }
    this.logger.info("remaining data length: %d", this.response.length);
    this.logger.debug("resulting buffer: %s", this.response);
    if(!this.commands.length)
        this.cancelTimer();
};

melted_node.prototype.processQueue = function() {
    this.logger.debug("[processQueue] called with %d commands pending", this.pending.length);
    if(!this.connected) {
        this.logger.debug("[processQueue] ignored, not connected");
        return;
    }
    this.logger.info("[processQueue] processing. %d commands pending", this.pending.length);
    while(this.pending.length) {
        var com = this.pending.shift();
        var command = com[0];
        this.logger.debug("sending %s", command);
        this.commands.push(com);
        this.server.write(command + "\r\n");
        this.logger.debug("timer: %s", '' + this.timer);
        if(!this.timer)
            this.setTimer();
    }
    this.logger.info("[processQueue] now waiting responses for %d commands", this.commands.length);
};

melted_node.prototype.addCommandToQueue = function(command) {
    this.logger.debug("[addCommandToQueue] Invoked for command: " + command);
    var com = [];
    var result = Q.defer();
    com[0] = command;
    com[1] = result;
    this.pending.push(com);

    if (!this.connected) {
        if (!this.started) {
            this.connect();
        }
    }
    this.processQueue();
    return result.promise;
};

melted_node.prototype.connect = function() {
    if (!this.started)
        this.started = true;
    var deferred = Q.defer();
    this.connects.take(this._connect.bind(this, deferred));
    return deferred.promise;
};

melted_node.prototype._connect = function(deferred) {
    this.logger.info("[connect] Invoked");

    if (this.connected) {
        this.logger.info("[connect] Server already connected");
        deferred.resolve("Server already connected");
        this.connects.leave();
        return;
    }
    this.emit('start-connection');

    this.server = new net.createConnection(this.port, this.host);
    this.server.setEncoding('ascii');
    this.server.setNoDelay(true);

    /*
      Event: 'connect'#
      Emitted when a socket connection is successfully established. See connect().
    */
    this.server.addListener("connect", (function() {
        this.logger.info("[connect] Connecting to Melted Server..." );
        // this listener will wait until the connection got a "100 VTR Ready" string,
        // answer to the 'connect' request, and go on. This depends on the fact
        // that the dataReceived listener has been registered first
        var readyListener = (function() {
            var readyStr = "100 VTR Ready\r\n";
            var match = this.response.match(readyStr);
            if(match) {
                if(match.index != 0) {
                    // got a match, but it's not first, weird
                    this.logger.warn("Got a match for ready string, but was not the first we got from the server: (%s)", this.response);
                    this.response = this.response.substr(match.index);
                }
                this.response = this.response.replace(readyStr, '');
                this.server.removeListener('data', readyListener)
                this.server.removeAllListeners('close');
                this.server.addListener('close', this.close.bind(this));
                this.connected = true;
                this.connects.leave();
                deferred.resolve('connected');
                this.processQueue();
                this.processResponse();
                // Once again, this depends on the fact
                // that the dataReceived listener has been registered first
                this.server.addListener('data', this.processResponse.bind(this));
                this.emit('connected');
            }
        }).bind(this);
        this.server.addListener('data', readyListener);
    }).bind(this));

    /*
      Event: 'data'#
      Buffer object
      Emitted when data is received. The argument data will be a Buffer
      or String. Encoding of data is set by socket.setEncoding(). (See
      the Readable Stream section for more information.)

      Note that the data will be lost if there is no listener when a
      Socket emits a 'data' event.
    */
    this.server.addListener('data', this.dataReceived.bind(this));

    /*
      Event: 'end'#
      Emitted when the other end of the socket sends a FIN packet.

      By default (allowHalfOpen == false) the socket will destroy its
      file descriptor once it has written out its pending write queue.
      However, by setting allowHalfOpen == true the socket will not
      automatically end() its side allowing the user to write arbitrary
      amounts of data, with the caveat that the user is required to
      end() their side now.
    */
    this.server.on('end', (function () {
        if (this.pending.length)
            this.logger.error("[connect] Got 'end' but still data pending");
        this.logger.info("[connect] Melted Server connection ended");
        this.emit('disconnect');
    }).bind(this));

    /*
      Event: 'timeout'#
      Emitted if the socket times out from inactivity. Self is only to
      notify that the socket has been idle. The user must manually close
      the connection.
    */

    /*
      Event: 'drain'#
      Emitted when the write buffer becomes empty. Can be used to
      throttle uploads.
    */

    /*
      Event: 'error'#
      Error object
      Emitted when an error occurs. The 'close' event will be called
      directly following self event.
    */
    this.server.on('error', (function(err) {
        this.logger.error("[connect] Could not connect to Melted Server", err);
        deferred.reject(err);
        this.emit('connection-error', err);
    }).bind(this));

    /*
      Event: 'close'#
      had_error Boolean true if the socket had a transmission error
      Emitted once the socket is fully closed. The argument had_error is
      a boolean which says if the socket was closed due to a
      transmission error.
    */
    this.server.once('close', (function(had_error) {
        this.close(had_error);
        this.connects.leave();
    }).bind(this));
};

melted_node.prototype.close = function(had_error) {
    if (had_error)
        this.logger.error("[connect] Melted Server connection closed with error");
    else
        this.logger.info("[connect] Melted Server connection closed");
    this.connected = false;
    this.server.removeAllListeners();
    //    this.server.destroy();
    delete this.server;
    this.emit('reconnect', had_error);
    setTimeout(this.connect.bind(this), 500);
};

melted_node.prototype.disconnect = function() {
    this.started = false;
    var deferred = Q.defer();
    this.connects.take(this._disconnect.bind(this, deferred));
    return deferred.promise;
};

melted_node.prototype._disconnect = function(deferred) {
    this.logger.info("[disconnect] Disconnecting from Melted Server");
    this.server.removeAllListeners();
    this.server.once('close', (function(had_error) {
        this.connected = false;
        delete this.server;
        deferred.resolve("Server Disconnected");
        this.commands.forEach(function(command) {
            command[1].reject(new Error("Server Disconnected"));
        });
        this.commands = [];
        this.pending.forEach(function(command) {
            command[1].reject(new Error("Server Disconnected"));
        });
        this.pending = [];
        this.logger.info("[disconnect] Disconnected from Melted Server");
        this.emit('disconnect');
        this.connects.leave();
    }).bind(this));
    this.server.destroy();
};

melted_node.prototype.sendCommand = function(command) {
    this.logger.debug("[sendPromisedCommand] Invoked for command: " + command);

    var result = this.addCommandToQueue(command);

    return result;
};

exports = module.exports = function(host, port, logger, timeout) {
    var mlt = new melted_node(host, port, logger, timeout);
    return mlt;
};
