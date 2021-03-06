/**
 * eleVR Web Player: A web player for 360 video on the Oculus
 * Copyright (C) 2014 Andrea Hawksley and Andrew Lutomirski
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

"use strict";

var container, canvas, video, playButton, muteButton, fullScreenButton,
    seekBar, videoSelect, projectionSelect,
    leftLoad, rightLoad, leftPlay, rightPlay, playL, playR;

var gl, reqAnimFrameID = 0;
var currentScreenOrientation = window.orientation || 0; // active default

var positionsBuffer,
    verticesIndexBuffer,
    lastUpdateTime = 0;

var texture, textureTime;

var mvMatrix, shader;

var stereoRenderer, vrstate, vrloaded = false;

var manualRotateRate = new Float32Array([0, 0, 0]),  // Vector, camera-relative
    manualRotation = quat.create(),
    manualControls = {
      'a' : {index: 1, sign: 1, active: 0},
      'd' : {index: 1, sign: -1, active: 0},
      'w' : {index: 0, sign: 1, active: 0},
      's' : {index: 0, sign: -1, active: 0},
      'q' : {index: 2, sign: -1, active: 0},
      'e' : {index: 2, sign: 1, active: 0},
    },
    deviceAlpha, deviceBeta, deviceGamma,
    deviceRotation = quat.create(),
    degtorad = Math.PI / 180, // Degree-to-Radian conversion

    prevFrameTime = null,
    showTiming = false;  // Switch to true to show frame times in the console

var ProjectionEnum = Object.freeze({
                  EQUIRECT: 0,
                  EQUIRECT_3D: 1}),
    projection = 0,

  videoObjectURL = null;

function runEleVRPlayer() {

  initElements();
  createControls();

  initWebGL();

  if (gl) {
    setCanvasSize();

    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clearDepth(1.0);
    gl.disable(gl.DEPTH_TEST);

    stereoRenderer = new vr.StereoRenderer(gl, {
      alpha: false,
      depth: false,
      stencil: false
    });

    vrstate = new vr.State();

    vr.load(function(error) {
      if (error)
        console.log('vr.js failed to initialize: ', error);
      vrloaded = true;
    });

    setCanvasSize();

    // Android Controls: Listen for orientation.
    var degtorad = Math.PI / 180; // Degree-to-Radian conversion
    if (window.DeviceOrientationEvent) {
      window.addEventListener('deviceorientation', function(orientation) {
        deviceAlpha = orientation.alpha;
        deviceGamma = orientation.gamma;
        deviceBeta = orientation.beta;
      }.bind(this));
    }

    // Keyboard Controls
    enableKeyControls();

    shader = new ShaderProgram(gl, {
      fragmentShaderName: 'shader-fs',
      vertexShaderName: 'shader-vs',
      attributes: ['aVertexPosition'],
      uniforms: ['uSampler', 'eye', 'projection', 'proj_inv'],
    });

    initBuffers();
    initTextures();

    video.addEventListener("canplaythrough", loaded);
    video.addEventListener("ended", ended);
    // video.preload = "auto";
  }
}

/**
 * Lots of Init Methods
 */
function initElements() {
  container = document.getElementById("video-container");
  container.style.width = window.innerWidth + "px";
  container.style.height = window.innerHeight + "px";
  leftLoad = document.getElementById("left-load");
  rightLoad = document.getElementById("right-load");
  leftPlay = document.getElementById("left-play");
  rightPlay = document.getElementById("right-play");
  canvas = document.getElementById("glcanvas");
  video = document.getElementById("video");

  // Buttons
  playButton = document.getElementById("play-pause");
  playL = document.getElementById("play-l");
  playR = document.getElementById("play-r");
  muteButton = document.getElementById("mute");
  fullScreenButton = document.getElementById("full-screen");

  // Sliders
  seekBar = document.getElementById("seek-bar");

  // Selectors
  videoSelect = document.getElementById("video-select");
  projectionSelect = document.getElementById("projection-select");

  document.getElementById('title-l').style.fontSize = window.outerHeight / 20 + 'px';
  document.getElementById('title-r').style.fontSize = window.outerHeight / 20 + 'px';
  document.getElementById('message-l').style.fontSize = window.outerHeight / 30 + 'px';
  document.getElementById('message-r').style.fontSize = window.outerHeight / 30 + 'px';
}

function initWebGL() {
  gl = null;

  try {
    gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
  } catch(e) {}

  if (!gl) {
    alert("Unable to initialize WebGL. Your browser may not support it.");
  }
}

function initBuffers() {
  positionsBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionsBuffer);
  var positions = [
    -1.0, -1.0,
     1.0, -1.0,
     1.0,  1.0,
    -1.0,  1.0,
  ];
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

  verticesIndexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, verticesIndexBuffer);
  var vertexIndices = [
    0,  1,  2,      0,  2,  3,
  ]
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,
      new Uint16Array(vertexIndices), gl.STATIC_DRAW);
}

function initTextures() {
  texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  textureTime = undefined;
}

function setCanvasSize() {
    // vr.js really wants device pixel size to be 1:1
    var screenWidth = window.innerWidth;
    var screenHeight = window.innerHeight;
    if (canvas.width != screenWidth || canvas.height != screenHeight) {
      canvas.width = screenWidth;
      canvas.height = screenHeight;

      canvas.style.width = screenWidth + 'px';
      canvas.style.height = screenHeight + 'px';
    }
}

function updateTexture() {
  if (textureTime !== video.currentTime) {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB,
      gl.UNSIGNED_BYTE, video);
    gl.bindTexture(gl.TEXTURE_2D, null);
    textureTime = video.currentTime;
  }
}

/**
 * Drawing the scene
 */
function drawOneEye(eye) {
  gl.useProgram(shader.program);

  gl.bindBuffer(gl.ARRAY_BUFFER, positionsBuffer);
  gl.vertexAttribPointer(shader.attributes['aVertexPosition'], 2, gl.FLOAT, false, 0, 0);

  // Specify the texture to map onto the faces.
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(shader.uniforms['uSampler'], 0);

  gl.uniform1f(shader.uniforms['eye'], eye.viewport[0]*2);
  gl.uniform1f(shader.uniforms['projection'], projection);

  var rotation = mat4.create();

  if (vrstate.hmd.present) {
    var totalRotation = quat.create();
    quat.multiply(totalRotation, manualRotation, vrstate.hmd.rotation);
    mat4.fromQuat(rotation, totalRotation);
  } else if (deviceAlpha && deviceBeta && deviceGamma) {
    var totalRotation = quat.create();
    quat.multiply(totalRotation, manualRotation, deviceRotation);
    mat4.fromQuat(rotation, totalRotation);
  } else {
    mat4.fromQuat(rotation, manualRotation);
  }

  var projectionInverse = mat4.create();
  mat4.invert(projectionInverse, eye.projectionMatrix)
  var inv = mat4.create();
  mat4.multiply(inv, rotation, projectionInverse);

  gl.uniformMatrix4fv(shader.uniforms['proj_inv'], false, inv);

  // Draw
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, verticesIndexBuffer);
  gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
}

function drawScene(frameTime) {
  if (showTiming)
    var start = performance.now();

  updateTexture();
  if (!vrloaded)
    return;

  if (showTiming)
    var textureLoaded = performance.now();

  vr.pollState(vrstate);
  if (prevFrameTime) {
    // Apply manual controls.
    var interval = (frameTime - prevFrameTime) * 0.001;

    var update = quat.fromValues(manualRotateRate[0] * interval,
                                 manualRotateRate[1] * interval,
                                 manualRotateRate[2] * interval, 1.0);
    quat.normalize(update, update);
    quat.multiply(manualRotation, manualRotation, update);

    if (deviceAlpha && deviceBeta && deviceGamma) {
      // Apply device orientation
      var z = deviceAlpha * degtorad / 2;
      var x = deviceBeta * degtorad / 2;
      var y = deviceGamma * degtorad / 2;
      var cX = Math.cos(x);
      var cY = Math.cos(y);
      var cZ = Math.cos(z);
      var sX = Math.sin(x);
      var sY = Math.sin(y);
      var sZ = Math.sin(z);

      // ZXY quaternion construction.
      var w = cX * cY * cZ - sX * sY * sZ;
      var x = sX * cY * cZ - cX * sY * sZ;
      var y = cX * sY * cZ + sX * cY * sZ;
      var z = cX * cY * sZ + sX * sY * cZ;

      var deviceQuaternion = quat.fromValues(x, y, z, w);

      // Correct for the screen orientation.
      var screenOrientation = (util.getScreenOrientation() * degtorad)/2;
      var screenTransform = [0, 0, -Math.sin(screenOrientation), Math.cos(screenOrientation)];

      quat.multiply(deviceRotation, deviceQuaternion, screenTransform);
    }
  }

  if (vrstate.hmd.present) {
    stereoRenderer.render(vrstate, drawOneEye, this);
  } else {
    stereoRenderer.render(vrstate, drawOneEye, this);
  }

  if (showTiming) {
    gl.finish();
    var end = performance.now();
    console.log('Frame time: ' +
		(start - frameTime) + 'ms animation frame lag + ' +
                (textureLoaded - start) + 'ms to load texture + ' +
                (end - textureLoaded) + 'ms = ' + (end - frameTime) + 'ms');
  }

  reqAnimFrameID = requestAnimationFrame(drawScene);
  prevFrameTime = frameTime;
}

/**
 * Shader Related Functions
 */
function ShaderProgram(gl, params) {
  this.params = params;
  this.fragmentShader = getShader(gl, this.params.fragmentShaderName);
  this.vertexShader = getShader(gl, this.params.vertexShaderName);

  this.program = gl.createProgram();
  gl.attachShader(this.program, this.vertexShader);
  gl.attachShader(this.program, this.fragmentShader);
  gl.linkProgram(this.program);

  if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
    alert("Unable to initialize the shader program: " + gl.getProgramInfoLog(this.program));
  }

  gl.useProgram(this.program);

  this.attributes = {}
  for (var i = 0; i < this.params.attributes.length; i++) {
    var name = this.params.attributes[i];
    this.attributes[name] = gl.getAttribLocation(this.program, name);
    gl.enableVertexAttribArray(this.attributes[name]);
  }

  this.uniforms = {}
  for (var i = 0; i < this.params.uniforms.length; i++) {
    var name = this.params.uniforms[i];
    this.uniforms[name] = gl.getUniformLocation(this.program, name);
    gl.enableVertexAttribArray(this.attributes[name]);
  }
}

function getShader(gl, id) {
  var shaderScript = document.getElementById(id);

  if (!shaderScript) {
    return null;
  }

  var theSource = "";
  var currentChild = shaderScript.firstChild;

  while(currentChild) {
    if (currentChild.nodeType == 3) {
      theSource += currentChild.textContent;
    }

    currentChild = currentChild.nextSibling;
  }

  var shader;

  if (shaderScript.type == "x-shader/x-fragment") {
    shader = gl.createShader(gl.FRAGMENT_SHADER);
  } else if (shaderScript.type == "x-shader/x-vertex") {
    shader = gl.createShader(gl.VERTEX_SHADER);
  } else {
    return null;  // Unknown shader type
  }

  gl.shaderSource(shader, theSource);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    alert("An error occurred compiling the shaders: " + gl.getShaderInfoLog(shader));
    return null;
  }

  return shader;
}

/**
 * Video Commands
 */
function loaded() {
  leftLoad.style.display = "none";
  rightLoad.style.display = "none";

  leftPlay.style.display = "block";
  rightPlay.style.display = "block";
}

function play(event) {
  if (video.ended) {
    video.currentTime = 0.1;
  }

  video.play();
  if (!video.paused) { // In case somehow hitting play button doesnt work
    leftPlay.style.display = "none";
    rightPlay.style.display = "none";

    playButton.className = "fa fa-pause icon";
    reqAnimFrameID = requestAnimationFrame(drawScene);
  }
}

function pause() {
  video.pause();
  playButton.className = "fa fa-play icon";
  leftPlay.style.display = "block";
  rightPlay.style.display = "block";
}

function ended() {
  pause();
  if (reqAnimFrameID) {
    cancelAnimationFrame(reqAnimFrameID);
    reqAnimFrameID = 0;
  }
}

function mute() {
  video.muted = true;
  muteButton.className = "fa fa-volume-off icon";
}

function unmute() {
  video.muted = false;
  muteButton.className = "fa fa-volume-up icon";
}

function selectLocalVideo() {
  var input = document.createElement("input");
  input.type = "file";
  input.accept = "video/*";

  input.addEventListener("change", function (event) {
    var files = input.files;
    if (!files.length) {
      // The user didn't select anything.  Sad.
      console.log('File selection canceled');
      return;
    }

    videoObjectURL = URL.createObjectURL(files[0]);
    console.log('Loading local file ', files[0].name,
		' at URL ', videoObjectURL);
    videoSelect.value = "";
    loadVideo(videoObjectURL);
  });

  input.click();
}

function loadVideo(videoFile) {
  pause();
  leftPlay.style.display = "none";
  rightPlay.style.display = "none";
  leftLoad.style.display = "block";
  rightLoad.style.display = "block";

  gl.clear(gl.COLOR_BUFFER_BIT);

  if (reqAnimFrameID) {
    cancelAnimationFrame(reqAnimFrameID);
    reqAnimFrameID = 0;
  }

  // Hack to fix rotation for vidcon video for vidcon
  if (videoFile == "Vidcon.webm") {
    manualRotation = [0.38175851106643677, -0.7102527618408203, -0.2401944249868393, 0.5404701232910156];
  } else {
    manualRotation = quat.create();
  }

  var oldObjURL = videoObjectURL;
  videoObjectURL = null;

  video.src = videoFile;

  if (videoObjectURL && videoObjectURL != videoFile) {
    URL.removeObjectURL(oldObjURL);
  }
}

function fullscreen() {
  if (video.requestFullscreen) {
    container.requestFullscreen();
  } else if (video.mozRequestFullScreen) {
    container.mozRequestFullScreen(); // Firefox
  } else if (video.webkitRequestFullscreen) {
    container.webkitRequestFullscreen(); // Chrome and Safari
  }
}

/**
 * Video Controls
 */
function createControls() {
  playButton.addEventListener("click", function() {
    if (video.paused == true) {
      play();
    } else {
      pause();
    }
  });

  playL.addEventListener("click", function() {
    if (video.paused == true) {
      play();
    } else {
      pause();
    }
  });

  playR.addEventListener("click", function() {
    if (video.paused == true) {
      play();
    } else {
      pause();
    }
  });

  muteButton.addEventListener("click", function() {
    if (video.muted == false) {
      mute();
    } else {
      unmute();
    }
  });

  fullScreenButton.addEventListener("click", function() {
    fullscreen();
  });

  seekBar.addEventListener("change", function() {
    // Calculate the new time
    var time = video.duration * (seekBar.value / 100);
    video.currentTime = time;
  });

  video.addEventListener("timeupdate", function() {
    // don't update if paused,
    // we get last time update after seekBar mousedown pauses
    if (!video.paused) {
      // Calculate the slider value
      var value = (100 / video.duration) * video.currentTime;
      seekBar.value = value;
    }
  });

  // Pause the video when the slider handle is being dragged
  var tempPause = false;
  seekBar.addEventListener("mousedown", function() {
    if (!video.paused) {
      video.pause();
      tempPause = true;
    }
  });

  seekBar.addEventListener("mouseup", function() {
    if (tempPause) {
      video.play();
    }
  });

  videoSelect.addEventListener("change", function() {
    projection = videoSelect.value[0];
    projectionSelect.value = projection;
    loadVideo(videoSelect.value.substring(1));
  });


  projectionSelect.addEventListener("change", function() {
    projection = projectionSelect.value;
  });

  document.getElementById("select-local-file").addEventListener("click", function(event) {
    event.preventDefault();
    selectLocalVideo();
  });
}

/**
 * Keyboard Controls
 */
function enableKeyControls() {
  function key(event, sign) {
    var control = manualControls[String.fromCharCode(event.keyCode).toLowerCase()];
    if (!control)
      return;
    if (sign == 1 && control.active || sign == -1 && !control.active)
      return;
    control.active = (sign == 1);
    manualRotateRate[control.index] += sign * control.sign;
  }

  document.addEventListener('keydown', function(event) { key(event, 1); },
          false);
  document.addEventListener('keyup', function(event) { key(event, -1); },
          false);
}
