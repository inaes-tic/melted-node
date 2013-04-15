var assert = require("assert");

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
        before(function(done) {
            mlt.sendCommand("no_such_command in my town", "200 OK");
            mlt.sendCommand("load u0 ./test/videos/SMPTE_Color_Bars_01.mp4", "200 OK");
            mlt.sendCommand("play u0", "200 OK");
            mlt.sendCommand("apnd u0 ./test/videos/SMPTE_Color_Bars_02.mp4", "200 OK");
            setTimeout(function() {
                done();
            }, 1000);
        });
        it('--should return 1 because of first command', function(){
            assert.equal (mlt.errors.length, 1);
        });
    });
});

describe('queue', function() {
    describe('#add commands after queue processed', function(){
        before(function(done) {
            mlt.sendCommand("pause u0", "200 OK");
            mlt.sendCommand("play u0", "200 OK");
            setTimeout(function() {
                done();
            }, 1000);
        });
        it('--should return 1 because of previous test', function(){
            assert.equal (mlt.errors.length, 1);
        });
    });
});

describe('callbacks', function() {
    describe('#execute callback function on success and on error', function() {
        var errorReceived = false;
        var responseReceived = false;
        before(function(done) {
            mlt.sendCommand("hohoho", "200 OK", undefined, callback);
            function callback(error) {
                console.error("TEST: Error: " + error);
                errorReceived = true;
                done();
            };
        });
        before(function(done) {
            mlt.sendCommand("list u0", "201 OK", callback);
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
            var result = mlt.sendPromisedCommand("jijijiji", "200 OK");
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
            var result = mlt.sendPromisedCommand("uls", "201 OK");
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

//describe('xml', function() {
//    describe('#add xml file with filter', function(){
//        before(function(done) {
//            mlt.sendCommand("load u0 ./test/melted-test.xml", "200 OK");
//            mlt.sendCommand("play u0", "200 OK");
//            setTimeout(function() {
//                done();
//            }, 1000);
//        });
//        it('--should return 3 because of previous test', function(){
//            assert.equal(mlt.errors.length, 3);
//        });
//    });
//});

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
                mlt.sendCommand("usta u0", "202 OK", function(response) {
                    console.log("USTA:" + response);
                    console.log("PASADA NRO: " + count);
                }, function(error) {
                    console.error("USTA: " + error);
                });
                console.log("mando goto");
                mlt.sendCommand("goto u0 " + count * 3, "200 OK", function(response) {
                    console.log("GOTO: " + response);
                }, function(error) {
                    console.error("GOTO: " + error);
                });
                count++;
            }, 500);
        });
        it('--should return 3 (no more errors!)', function(){
            assert.equal(mlt.errors.length, 3);
        });
        after(function(done) {
//            setTimeout(function() {
                mlt.sendCommand("stop u0", "200 OK", function(result) {
                    done();
                });
//            }, 2500);
        });
    }) ;
});