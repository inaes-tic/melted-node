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
        deferred.resolve(this.expect("100 VTR Ready").then((function() {
            this.logger.info("[connect] Connected to Melted Server" );
            this.server.removeAllListeners('close');
            this.server.addListener('close', this.close.bind(this));
            this.connected = true;
            //this.connecting = false;
            this.connects.leave();
            this.processQueue();
        }).bind(this)));
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
