/** A small real-browser smoke test. Every server run owns a fresh temporary namespace. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import puppeteer from 'puppeteer';

const directory = await mkdtemp(join(tmpdir(), 'metalist-browser-'));
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const env = {...process.env};
for (const key of Object.keys(env)) {
  if (key.startsWith('METALIST_') || key === 'TEST_MODE') delete env[key];
}
env.METALIST_DATA_DIRECTORY = directory;
env.METALIST_ENVIRONMENT = 'production';
env.METALIST_PORT = String(port);
env.API_PREFIX = '/api2';
env.V1_API_PREFIX = '/api';
const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
let logs = '';
const server = spawn(resolve(python), ['serve_namespace.py','--namespace','default','--port',String(port)], {env, stdio:['ignore','pipe','pipe']});
server.stdout.on('data', chunk => { logs += chunk; });
server.stderr.on('data', chunk => { logs += chunk; });
let browser;
try {
  let ready = false;
  for (let count=0; count<300; count++) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${logs}`);
    try { const response = await fetch(`${origin}/api2/auth/status`, {headers:{"X-Metalist-Tab-Id":"smoke-readiness"}}); if (response.ok) {ready=true; break;} throw new Error(`Readiness failed: ${response.status} ${await response.text()}`); }
    catch (error) { if (error.cause?.code !== 'ECONNREFUSED') throw error; }
    await delay(100);
  }
  assert(ready, 'Server did not become ready');
  browser = await puppeteer.launch({headless:true});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.waitForSelector('[data-app-ready="true"]', {timeout:30000});
  await page.waitForNetworkIdle({idleTime:500});
  const noteId = await page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const created = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(created.id, '<p>Browser smoke original</p>', '');
    await NotesAPI.saveNote(created.id, '<p>Browser smoke changed</p>', '');
    const undone = await NotesAPI.undo();
    if (undone.status !== 'success') throw new Error('Undo failed');
    return created.id;
  });
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await page.waitForFunction(() => document.body.textContent.includes('Browser smoke original'));
  assert(!await page.evaluate(() => document.body.textContent.includes('Browser smoke changed')));
  console.log('PASS browser initialization, create/edit/undo, and reload');

  const fileId = await page.evaluate(async () => {
    const {buildSessionHeaders} = await import('/static/js/modules/session-auth.js');
    const form = new FormData();
    form.append('file', new File(['browser fixture'], 'fixture.txt', {type:'text/plain'}));
    const uploaded = await fetch('/api2/files/upload', {method:'POST',headers:buildSessionHeaders(false),body:form});
    if (!uploaded.ok) throw new Error(`Upload failed: ${uploaded.status}`);
    const record = await uploaded.json();
    const downloaded = await fetch(`/api2/files/${record.file_id}/download`, {headers:buildSessionHeaders(false)});
    if (await downloaded.text() !== 'browser fixture') throw new Error('Attachment content mismatch');
    return record.file_id;
  });
  console.log('PASS browser attachment round-trip');

  const password = 'Smoke-only-password!2026';
  await page.evaluate(async password => {
    const {buildSessionHeaders} = await import('/static/js/modules/session-auth.js');
    const response = await fetch('/api2/auth/settings/password/create', {method:'POST', headers:buildSessionHeaders(true), body:JSON.stringify({password})});
    if (!response.ok) throw new Error(`Password setup failed: ${response.status}`);
  }, password);
  await page.reload();
  await page.waitForSelector('#login-password', {visible:true});
  await page.type('#login-password', password);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector('[data-app-ready="true"]', {timeout:30000});
  await page.waitForFunction(() => document.body.textContent.includes('Browser smoke original'));
  const backupFilename = await page.evaluate(async () => {
    const {buildSessionHeaders} = await import('/static/js/modules/session-auth.js');
    const response = await fetch('/api2/auth/backup/create', {method:'POST',headers:buildSessionHeaders(true)});
    if (!response.ok) throw new Error(`Backup failed: ${response.status}`);
    return (await response.json()).backup.filename;
  });
  const backupPath = join(directory,'namespaces','default','backups',backupFilename);
  const backupHash = createHash('sha256').update(await readFile(backupPath)).digest('hex');
  await page.evaluate(async ({noteId, backupFilename}) => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const {buildSessionHeaders} = await import('/static/js/modules/session-auth.js');
    await NotesAPI.saveNote(noteId, '<p>Changed after backup</p>', '');
    const response = await fetch('/api2/auth/backup/restore', {method:'POST',headers:buildSessionHeaders(true),body:JSON.stringify({filename:backupFilename})});
    if (!response.ok) throw new Error(`Restore failed: ${response.status}`);
  }, {noteId, backupFilename});
  // Restore re-execs the same owned server process; observe its second startup.
  for (let attempt=0; attempt<300 && logs.split('Application startup complete.').length<3; attempt++) await delay(100);
  assert(logs.split('Application startup complete.').length>=3, 'Restored server did not restart');
  await page.reload();
  await page.waitForSelector('#login-password', {visible:true});
  await page.type('#login-password', password);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector('[data-app-ready="true"]', {timeout:30000});
  await page.waitForFunction(() => document.body.textContent.includes('Browser smoke original'));
  assert(!await page.evaluate(() => document.body.textContent.includes('Changed after backup')));
  assert.equal(createHash('sha256').update(await readFile(backupPath)).digest('hex'), backupHash);
  console.log('PASS encrypted backup restore, actual restart, reauthentication, and archive immutability');
  await page.evaluate(async () => { const {actionUndo} = await import('/static/js/modules/mode-manager/actions/history-actions.js'); await actionUndo(); });
  await page.waitForFunction(() => document.body.textContent.includes('No actions to undo'));
  console.log('PASS empty undo history shows an explanatory banner');
  await page.evaluate(async () => { const {Auth} = await import('/static/js/modules/auth.js'); await Auth.logout(); });
  await page.waitForSelector('#login-password', {visible:true});
  console.log('PASS password setup, login, hydration, and logout');
  assert.deepEqual(errors, []);
  await writeFile(join(directory,'result.json'), JSON.stringify({passed:true,noteId,fileId}));
  console.log(`Browser smoke passed; disposable artifacts: ${directory}`);
} catch (error) {
  await writeFile(join(directory,'server.log'), logs);
  console.error(`Browser smoke failed; disposable logs: ${directory}`);
  throw error;
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  const stopped = new Promise(resolve => server.once('exit', resolve));
  await Promise.race([stopped, delay(5000)]);
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
}
