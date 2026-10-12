import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/js/camera.js', import.meta.url), 'utf8').replaceAll('export ', '');

function setup(){
  let stopped = 0, cleared = 0;
  const statuses = [], timers = [];
  const track = { readyState: 'live', stop(){ stopped++; this.readyState = 'ended'; }, applyConstraints: async () => {}, getSettings: () => ({ deviceId: 'rear' }) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const video = { srcObject: null, videoWidth: 1920, videoHeight: 1080, play: async () => {} };
  const mediaDevices = { getUserMedia: async () => stream, enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'rear' }] };
  const createCamera = runInNewContext(source + '; createCamera;', {
    navigator: { mediaDevices }, window: { cv: { Mat(){} } },
    setInterval: () => 7, clearInterval: () => cleared++,
    setTimeout: callback => timers.push(callback)
  });
  const camera = createCamera({ video, onStatus: status => statuses.push(status), onFrame(){}, isPaused: () => false });
  return { camera, mediaDevices, video, stream, timers, statuses, stopped: () => stopped, cleared: () => cleared };
}

test('stop releases the active camera, clears the preview and ends detection', async () => {
  const env = setup();
  const pending = env.camera.start();
  while (!env.timers.length) await Promise.resolve();
  env.timers.shift()();
  await pending;
  assert.equal(env.video.srcObject, env.stream);
  assert.equal(env.camera.isAutofocusReady(), true);
  await env.camera.stop();
  assert.equal(env.stopped(), 1);
  assert.equal(env.cleared(), 1);
  assert.equal(env.video.srcObject, null);
  assert.equal(env.camera.isAutofocusReady(), false);
});

test('stop during permission prompt releases a late camera stream', async () => {
  const env = setup();
  let resolveMedia;
  env.mediaDevices.getUserMedia = () => new Promise(resolve => { resolveMedia = resolve; });
  const pending = env.camera.start();
  await Promise.resolve();
  await env.camera.stop();
  resolveMedia(env.stream);
  await pending;
  assert.equal(env.stopped(), 1);
  assert.equal(env.video.srcObject, null);
  assert.equal(env.statuses.length, 0);
});

test('stop during autofocus prevents camera setup from resuming', async () => {
  const env = setup();
  const pending = env.camera.start();
  while (!env.timers.length) await Promise.resolve();
  await env.camera.stop();
  env.timers.shift()();
  await pending;
  assert.equal(env.stopped(), 1);
  assert.equal(env.video.srcObject, null);
  assert.equal(env.statuses.length, 0);
  assert.equal(env.camera.isAutofocusReady(), false);
});

test('a denied permission request after stop does not interrupt the returned view', async () => {
  const env = setup();
  let rejectMedia;
  env.mediaDevices.getUserMedia = () => new Promise((resolve, reject) => { rejectMedia = reject; });
  const pending = env.camera.start();
  await Promise.resolve();
  await env.camera.stop();
  rejectMedia(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
  await pending;
  assert.equal(env.video.srcObject, null);
  assert.equal(env.statuses.length, 0);
});
