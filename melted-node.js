var net       = require('net')
,   Q         = require('q')
,   moment    = require('moment')
,   semaphore = require('semaphore')
,   winston   = require('winston');

function melted_node(host, port, logger, timeout) {
    this.server     = false;
    this.errors     = [];
    this.pending    = [];
    this.connected  = false;
    this.commands   = [];
    this.connects   = semaphore(1);
    this.response   = '';
    this.started    = false;
    this.timeout    = timeout || 2000;
    this.host       = host || 'localhost';
    this.port       = port || 5250;
    this.logger     = logger || new (winston.Logger)({
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
};

melted_node.prototype.dataReceived = function(data) {
    this.logger.info("[dataReceived] Got: " + data);
    this.response += data;
};

melted_node.prototype.processResponse = function() {
    this.logger.info('[processResponse] try to process """%s"""', this.response);
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
        return;
    }

    var status = spl[0];
    this.logger.debug("Processing status: %s", status);

    var com = this.commands[0];
    var deferred = com[1];
    var cont = false;
    if(status == "200 OK") {
        // Just an OK message.
        this.response = this.response.replace(status + "\r\n");
        this.commands.shift();
        deferred.resolve(true);
    } else if(status == "201 OK") {
        // multi-lined response. wait for "\r\n\r\n"
        var splitted = this.response.split("\r\n\r\n");
        if(splitted[1] !== undefined) {
            // "201 OK\r\nfoo\r\n\r\n".split("\r\n\r\n") ==> ['201 OK\r\nfoo', ''], so ...split(..)[1] === undefined is false
            this.commands.shift();
            var ret = splitted[0];
            this.response = splitted.slice(1).join("\r\n\r\n");
            deferred.resolve(ret);
            cont = true;
        }
    } else if(status == "202 OK") {
        // one-line response. wait for "\r\n"
        var splitted = this.response.split("\r\n");
        if(splitted[2] !== undefined) {
            // "202 OK\r\nfoo\r\n".split("\r\n") ==> ['202 OK', 'foo', ''], so ...split(..)[2] === undefined is false
            // so I've got the whole response
            this.commands.shift();
            var ret = splitted.slice(0, 2);  // ['202 OK', 'foo']
            // re-join the rest of the buffer
            this.response = splitted.slice(2).join("\r\n");
            /* so in the case we had "202 OK\r\nfoo\r\nbar", this will become "bar".
               IF we had "202 OK\r\nfoo\r\n\r\n", this will become "\r\n",
               but this should *not* happen. In any case, the "header" of the
               next response will not be recognized and will be dropped, so the
               process won't brake (but a warning will be logged
            */
            deferred.resolve(ret.join("\r\n")); // "202 OK\r\nfoo" (drops the final \r\n)
            cont = true;
        }
    } else if(status.match(/^[45][0-9][0-9]/)) {
        // we've got an error
        deferred.reject(new Error(status));
        cont = true;
    } else {
        // I don't know what we have here, but we're never going to be able to process it. Lose it
        this.logger.warn("I got an unknown beginning of response. I'm ignoring it: \"%s\"", status);
        // drop the offending line
        this.response = this.response.replace(status + "\r\n", "");
        cont = true;
    }

    // if we processed something and still have data to process, have another go
    if(cont && this.response) {
        setTimeout(this.processResponse.bind(this), 0);
    }
};

melted_node.prototype.addCommandToQueue = function(command) {
    this.logger.debug("[addCommandToQueue] Invoked for command: " + command);
    var com = [];
    var result = Q.defer();
    com[0] = command;
    com[1] = result;
    this.commands.push(com);
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
                this.connected = true;
                this.server.addListener('close', this.close.bind(this));
                this.connects.leave();
                deferred.resolve('connected');
                this.processResponse();
                // Once again, this depends on the fact
                // that the dataReceived listener has been registered first
                this.addListener('data', this.processResponse.bind(this));
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
    setTimeout(this.connect.bind(this), 500);
};

melted_node.prototype.disconnect = function() {
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
        this.logger.info("[disconnect] Disconnected from Melted Server");
        this.connects.leave();
    }).bind(this));
    this.server.destroy();
};

melted_node.prototype.sendPromisedCommand = function(command) {
    this.logger.debug("[sendPromisedCommand] Invoked for command: " + command);

    var result = this.addCommandToQueue(command);

    if (!this.connected) {
        if (!this.started)
            this.connect();
    }
    return result;
};

melted_node.prototype.sendCommand = function(command, onSuccess, onError) {
    this.logger.debug("[sendCommand] Invoked for command: " + command);

    var result = this.addCommandToQueue(command);
    result.then(onSuccess, onError).done();

    if (!this.connected) {
        if (!this.started)
            this.connect();
    }
};

exports = module.exports = function(host, port, logger, timeout) {
    var mlt = new melted_node(host, port, logger, timeout);
    return mlt;
};
