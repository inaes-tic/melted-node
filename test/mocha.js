var assert = require("assert");
var _ = require("underscore");
var net = require('net');

var melted_node = require('../melted-node');
var mlt = new melted_node('localhost', 5250);

// SILENCE LOG OUTPUT
/*var util = require('util');
var fs = require('fs');
var log = fs.createWriteStream('/home/jmrunge/stdout.log');

console.log = console.info = function(t) {
  var out;
  if (t && ~t.indexOf('%')) {
    out = util.format.apply(util, arguments);
    process.stdout.write(out + '\n');
    return;
  } else {
    out = Array.prototype.join.call(arguments, ' ');
  }
  out && log.write(out + '\n');
};*/
// END SILENCE LOG OUTPUT

describe('connects', function(){
    before(function(done) {
        var result = mlt.connect();
        result.then(function() {
            done();
        }, function(err) {
            console.error("Error: " + err);
        });
    });
    describe('#connected', function(){
        it('--should return true', function(){
            assert.equal (mlt.connected, true);
        });
    });
    describe('#no pending messages', function(){
        it('--should return 0', function(){
            assert.equal (mlt.pending.length, 0);
        });
    });
    describe('#no errors', function(){
        it('--should return 0', function(){
            assert.equal (mlt.errors.length, 0);
        });
    });

});

describe('commands', function(){
    describe('#bad and good commands', function(){
        it('--should fail with unknown commands', function(done){
            mlt.sendCommand("no_such_command in my town").then(
                function(val){
                    return done(new Error(val));
                }, function(){ done(); });
        });
        it('--"load" should pass', function(done) {
            mlt.sendCommand("load u0 ./test/videos/SMPTE_Color_Bars_01.mp4").then(function(){done();}).done();
        });
        it('-- "play" should pass (after "load")', function(done) {
            mlt.sendCommand("play u0").then(function(){ done() }).done();
        });
        it('-- "append" shuold pass', function(done) {
            mlt.sendCommand("apnd u0 ./test/videos/SMPTE_Color_Bars_02.mp4").then(function() { done() }).done();
        });
    });
});

describe('queue', function() {
    describe('#add commands after queue processed', function(){
        before(function(done) {
            mlt.sendCommand("pause u0");
            mlt.sendCommand("play u0");
            setTimeout(function() {
                done();
            }, 1000);
        });
        it('--should return 1 because of previous test', function(){
            assert.equal (mlt.errors.length, 1);
        });
    });
});

describe('promise handlers', function() {
    describe('#execute handler function on success and on error', function() {
        var errorReceived = false;
        var responseReceived = false;
        before(function(done) {
            mlt.sendCommand("hohoho").then(undefined, callback);
            function callback(error) {
                console.error("TEST: Error: " + error);
                errorReceived = true;
                done();
            };
        });
        before(function(done) {
            mlt.sendCommand("list u0").then(callback);
            function callback(response) {
                console.log("TEST: Response: " + response);
                responseReceived = true;
                done();
            };
        });
        it('--incremented error count', function(){
            assert.equal (mlt.errors.length, 2);
        });
        it('--received error', function(){
            assert.equal (errorReceived, true);
        });
        it('--received response', function(){
            assert.equal (responseReceived, true);
        });
    });
});

describe('promised command', function() {
    describe('#receive promised object', function() {
        var error1Received = false;
        var response1Received = false;
        var error2Received = false;
        var response2Received = false;
        before(function(done) {
            var result = mlt.sendCommand("jijijiji");
            result.then(function(response) {
                console.log("TEST: Response: " + response);
                response1Received = true;
                done();
            }, function(error) {
                console.error("TEST: Error: " + error);
                error1Received = true;
                done();
            });
        });
        before(function(done) {
            var result = mlt.sendCommand("uls");
            result.then(function(response) {
                console.log("TEST: Response: " + response);
                response2Received = true;
                done();
            }, function(error) {
                console.error("TEST: Error: " + error);
                error2Received = true;
                done();
            });
        });
        it('--incremented error count', function(){
            assert.equal (mlt.errors.length, 3);
        });
        it('--received error for bad command', function(){
            assert.equal (error1Received, true);
        });
        it('--received response for bad command', function(){
            assert.equal (response1Received, false);
        });
        it('--received error for good command', function(){
            assert.equal (error2Received, false);
        });
        it('--received response for good command', function(){
            assert.equal (response2Received, true);
        });
    });
});

describe('xml', function() {
    describe('#add xml file with filter', function(){
        before(function(done) {
            mlt.sendCommand("load u0 ./test/melted-test.xml");
            mlt.sendCommand("play u0");
            setTimeout(function() {
                done();
            }, 1000);
        });
        it('--should return 3 because of previous test', function(){
            assert.equal(mlt.errors.length, 3);
        });
    });
});

describe('stress', function() {
    this.timeout(0);
    describe('#obtain status 100 times', function() {
        before(function(done) {
            var count = 0;
            setInterval(function() {
                if (count === 100) {
                    clearInterval(this);
                    done();
                }
                mlt.sendCommand("usta u0").then(function(response) {
                    console.log("USTA:" + response);
                    console.log("PASADA NRO: " + count);
                }, function(error) {
                    console.error("USTA: " + error);
                });
                console.log("mando goto");
                mlt.sendCommand("goto u0 " + count * 3).then(function(response) {
                    console.log("GOTO: " + response);
                }, function(error) {
                    console.error("GOTO: " + error);
                });
                count++;
            }, 50);
        });
        it('--should return 3 (no more errors!)', function(){
            assert.equal(mlt.errors.length, 3);
        });
        after(function(done) {
            mlt.sendCommand("stop u0").fin(function(result) {
                done();
            });
        });
    });

    describe("# send 100 random commands", function() {
        before(function(done) {
            mlt.sendCommand("clear u0").then(function() {
                done();
            }, done);

            // define String.startsWith
            if (typeof String.prototype.startsWith != 'function') {
                String.prototype.startsWith = function (str){
                    return this.slice(0, str.length) == str;
                };
            }
        });
        after(function(done) {
            console.log("after");
            mlt.sendCommand("stop u0");
            mlt.sendCommand("clear u0").then(function() { done() }, done);
        });
        it("-- and make sure the responses are correct", function(done){
            this.timeout(3000);
            var commands = [
                ["stop u0", "200 OK"],
                ["play u0", "200 OK"],
                ["apnd u0 ./test/videos/SMPTE_Color_Bars_01.mp4", "200 OK"],
                ["apnd u0 ./test/videos/SMPTE_Color_Bars_02.mp4", "200 OK"],
                ["apnd u0 ./test/videos/SMPTE_Color_Bars_03.mp4", "200 OK"],
                ["usta u0", "202 OK"],
                ["unknown command", undefined, "400 Unknown command"],
                ["list u0", "201 OK"],
            ];
            var count = 100;
            var good = _.after(count, function() {
                done();
            });
            var counter = 0;
            _.range(count).forEach(function(i){
                (function(com) {
                    mlt.sendCommand(com[0]).then(function(res) {
                        if(res.startsWith(com[1])) {
                            assert.equal(counter, i);
                            counter++;
                            good();
                        } else {
                            done(new Error(res));
                        };
                    }, function(err) {
                        if(com[2]) {
                            assert.equal(counter, i);
                            counter++;
                            good();
                        } else {
                            done(err);
                        }
                    }).fail(function(err){
                        done(err)
                    });
                })(commands[_.random(commands.length-1)]);
            });
        });
    });
});

describe('disconnect', function() {
    this.timeout(0);
    it('having commands in queue and disconnect shouldnt throw errors', function(done) {
        assert.doesNotThrow(function() {
            mlt.sendCommand("usta u0");
            mlt.sendCommand("usta u0");
            mlt.sendCommand("usta u0");
            mlt.sendCommand("usta u0");
            mlt.sendCommand("usta u0");
            mlt.disconnect().then(function(result) {
                console.log(result);
            }).fail(function(error) {
                console.log(error);
            }).fin(done);
        });
    });
    it('--disconnected', function() {
        assert.equal(mlt.connected, false);
    });
    it("reconnecting shouldn't throw errors", function(done) {
        mlt.sendCommand("usta u0");
        mlt.connect().then(function() {
            mlt.sendCommand("usta u0").then(function(){
                done();
            }, done);
        });
    });
});

describe("fake melted", function() {
    var self = this;
    before(function(done) {
        // just create a server that sends a melted "ready" message and then responds to nothing
        self.mlt_mock = net.createServer(function(c) {
            c.write("100 VTR Ready\r\n");
        });
        self.mlt_mock.listen(2222, function() { done() });
        mlt = new melted_node('localhost', 2222);
    });
    after(function(done) {
        self.mlt_mock.close(function() { done() });
    });
    describe("--timeouts", function() {
        this.timeout(3000);
        beforeEach(function(done) {
            mlt.connect().then(function() { done() }).done();
        });
        afterEach(function(done) {
            mlt.disconnect().then(function() { done() }).done();
        });
        it("# should timeout after sending a command and waiting 2 seconds", function(done) {
            mlt.on('response-timeout', function() {
                mlt.removeAllListeners('response-timeout');
                done();
            });
            mlt.sendCommand("USTA U0");
        });
        it("# when timed out, pending commands should fail", function(done) {
            var r = mlt.sendCommand("USTA U0").then(function() {
                done(new Error("Got a response, and should have timed out!"));
            }).fail(function() {
                done();
            });
        });
        it("# waiting for two seconds without sending commands should NOT time out", function(done){
            mlt.on('response-timeout', function() {
                mlt.removeAllListeners('response-timeout');
                done(new Error("melted-node sent a timeout event"));
            });
            setTimeout(function() {
                mlt.removeAllListeners('response-timeout');
                done();
            }, 2400);
        });
    });
});
