var net = require('net'), 
    Q = require('q');

function melted_node(host, port) {
    var self = this;

    this.server     = false;
    this.errors     = [];
    this.pending    = [];
    this.connected  = false;
    this.connecting = false;
    this.commands   = [];
    this.processing = false;
    this.host       = host;
    this.port       = port;
    
    if (this.host === undefined)
        this.host = 'localhost';
    if (this.port === undefined)
        this.port = 5250;

    melted_node.prototype.connect = function() {
        console.log("melted-node: [connect] Invoked");

        self.connecting = true;

        var deferred = Q.defer();

        self.server = new net.createConnection(this.port, this.host);
        self.server.setEncoding('ascii');

        /*
          Event: 'connect'#
          Emitted when a socket connection is successfully established. See connect().
        */
        self.server.on("connect", function() {
            console.log("melted-node: [connect] Connected to Melted Server" );
            deferred.resolve(expect("100 VTR Ready").then(function() {
                self.connected = true;
                self.connecting = false;
                processQueue();				
            }));
        });

        /*
          Event: 'data'#
          Buffer object
          Emitted when data is received. The argument data will be a Buffer
          or String. Encoding of data is set by socket.setEncoding(). (See
          the Readable Stream section for more information.)

          Note that the data will be lost if there is no listener when a
          Socket emits a 'data' event.
        */
        self.server.addListener('data', addPendingData);

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
        self.server.on('end', function () {
            if (self.pending.length)
                console.error ("melted-node: [connect] Got 'end' but still data pending");
            self.connected = false;
        });

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
        self.server.on('error', function(err) {
            console.log("melted-node: [connect] Could not connect to Melted Server: " + err);
            self.connecting =  false;
            deferred.reject(err);
        });

        /*
          Event: 'close'#
          had_error Boolean true if the socket had a transmission error
          Emitted once the socket is fully closed. The argument had_error is
          a boolean which says if the socket was closed due to a
          transmission error.
        */
        self.server.on('close', function (had_error) {
            self.connected = false;
        });

        return deferred.promise;
    };

    melted_node.prototype.sendPromisedCommand = function(command, expected) {
        console.log("melted-node: [sendPromisedCommand] Invoked for command: " + command + ", expected: " + expected);

        var result = addCommandToQueue(command, expected);

        if (!self.connected) { 
            if (!self.connecting) {
                self.connect();
            }
        } else if (!self.processing) {
            processQueue();
        }

        return result;
    };

    melted_node.prototype.sendCommand = function(command, expected, onSuccess, onError) {
        console.log("melted-node: [sendCommand] Invoked for command: " + command + ", expected: " + expected);

        var result = addCommandToQueue(command, expected);
        result.then(onSuccess, onError).done();

        if (!self.connected) { 
            if (!self.connecting) {
                self.connect();
            }
        } else if (!self.processing) {
            processQueue();
        }
    };

    function addPendingData (data) {
        if (data.match(/[^\s]/)) {
            self.pending.push(data);
            console.warn("melted-node: [addPendingData] Got " + self.pending.length + " data pending.");
            console.warn("melted-node: [addPendingData] Data: " + data);
        }
    };

    function processQueue() {
        console.log("melted-node: [processQueue] Invoked"); 

        if (!self.processing)
            self.processing = true;

        var command = self.commands.shift();

        if (command !== undefined) {
            console.log("melted-node: [processQueue] Processing command: " + command[0]);
            var result = _sendCommand(command[0], command[1], command[2]);

            result.then(function() {
                if (onSuccess !== undefined) {
                    console.log("melted-node: [processQueue] Calling success callback: " + onSuccess.name);
                    onSuccess(result);
                }
                processQueue();
            }, function(error) {
                var err = new Error("melted-node: [processQueue] Error processing command: " + command[0] + " [" + error + "]");
                console.error(err);
                self.errors.push(err);
                processQueue();
                if (onError !== undefined) {
                    console.log("melted-node: [processQueue] Calling error callback: " + onError.name);
                    onError(error);
                }
            });		
        } else {
            console.log("melted-node: [processQueue] Nothing else to process");
            self.processing = false;
        }
    }

    function addCommandToQueue(command, expected) {
        console.log("melted-node: [addCommandToQueue] Invoked for command: " + command + ", expected: " + expected);
        var com = [];
        var result = Q.defer();
        com[0] = command;
        com[1] = expected;
        com[2] = result;
        self.commands.push(com);
        return result.promise;
    }

    function _sendCommand(command, expected, deferred) {
        console.log("melted-node: [_sendCommand] Sending command: " + command);

        self.server.write(command + "\n");

        var aux = command.split("\ ");

        deferred.resolve(expect(expected, aux[0]));

        return deferred.promise;
    };

    function expect(expected, command, prefix) {
        console.log("melted-node: [expect] Invoked to expect: " + expected + " for command:" + command);
		
        var deferred = Q.defer();
        self.server.removeListener('data', addPendingData);
        self.server.once('data', function(data) {
            self.server.addListener('data', addPendingData);
            console.log("melted-node: [expect] Received: " + data + " Expected:" + expected);
            /* FIX for Issue 1 */
            var end_resp = false;
            if (prefix !== undefined) 
                data = prefix + "\r" + "\n" + data;
            var datax = data.split("\r\n");
            var i = 0;
            var sep = "";
            for(i = 0, data = "", sep = ""; i < datax.length; i++) {
                if (datax[i] !== "") { 
                    data = data + sep + datax[i]; 
                    sep = "\r" + "\n"; 
                } 
                if (datax[i] === "402 Argument missing") { 
                    end_resp =  true; 
                } 
            }
            /* END FIX for Issue 1 */
            var resp = data.replace(/\r\n/g, "");
            console.log("melted-node: [expect] Formatted Response: " + resp );
            if (resp.length === 0) {
                console.log("melted-node: [expect] Received empty string, retrying. with prefix: " + prefix );
                deferred.resolve(expect(expected, command, prefix));
            } else {
                if (prefix === undefined) {
                    if (resp.substring(0, expected.length) === expected) {
                        console.log("melted-node: [expect] Received expected response");
                        deferred.resolve(expect(expected, command, data));
                    } else {
                        console.error("melted-node: [expect] Expected '" + expected + "' but got '" + resp + "' !");
                        deferred.resolve(expect(expected, command, data));
                    }
                    //HACK: to know when the response ends, we send a fake command and wait for its response
                    self.server.write("get\n");
                } else {
                    //HACK: here we read the response of the fake command sent above to see if response ended or not
                    if (resp === "402 Argument missing" || end_resp ) {
                        //HACK: if we received the expected response to the fake command, response of the real command ended
                        var pfx = prefix.replace(/\r\n/g, "");
                        if ((pfx.substring(0, 1) === "2") || (pfx === "100 VTR Ready"))
                            deferred.resolve( data );
                        else
                            deferred.reject( data );
                    } else {
                        //HACK: if response is other than the expected for the fake command, we continue listening
                        deferred.resolve(expect(expected, command, data));
                    }
                }
            }
        });
        return deferred.promise;
    };

};

exports = module.exports = function(host, port) {
    var mlt = new melted_node(host, port);
    return mlt;
};
