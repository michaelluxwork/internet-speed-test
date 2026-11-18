import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { measure } from './speed-test.mjs';
import { REQUEST_COUNT, OUTPUT_DECIMAL_PLACES, ERROR_EXIT_CODE } from './constants.mjs';

const FIRST_CHUNK_BYTES = 1000;
const LAST_CHUNK_BYTES = 2000;
const BODY_DELAY_MS = 20;
const MIN_EXPECTED_DURATION_MS = 15;
const TEST_TIMEOUT_MS = 100;
const DISCONNECT_DELAY_MS = 10;
const DECLARED_BODY_BYTES = 1000;
const CHILD_PROCESS_TIMEOUT_MS = 5000;
const SMALL_BODY = 'abc';
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_NO_CONTENT = 204;
const HTTP_REDIRECT = 302;
const FLOAT_TOLERANCE = 1e-9;

// Независимый эталон: 30 000 байт за 10 запросов дают скорость 24 / среднее время в мс.
const EXPECTED_TOTAL_BYTES = 30_000;
const EXPECTED_SPEED_TIME_PRODUCT = 24;

async function withServer(handler, check) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await check(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('10 последовательных запросов полностью читают тело и верно считают результат', async () => {
  assert.equal(REQUEST_COUNT, 10, 'По условию задания требуется ровно 10 запросов');
  let requests = 0;
  let active = 0;
  let peak = 0;
  await withServer((req, res) => {
    requests++;
    peak = Math.max(peak, ++active);
    assert.equal(req.headers['accept-encoding'], 'identity');
    res.write(Buffer.alloc(FIRST_CHUNK_BYTES));
    setTimeout(() => {
      active--;
      res.end(Buffer.alloc(LAST_CHUNK_BYTES));
    }, BODY_DELAY_MS);
  }, async url => {
    const result = await measure(url);
    assert.equal(requests, REQUEST_COUNT);
    assert.equal(peak, 1);
    assert.equal(result.totalBytes, EXPECTED_TOTAL_BYTES);
    assert.ok(result.averageMs >= MIN_EXPECTED_DURATION_MS);
    assert.ok(Math.abs(result.speedMbps * result.averageMs - EXPECTED_SPEED_TIME_PRODUCT) < FLOAT_TOLERANCE);
  });
});

test('HTTP-ошибка останавливает серию на первом запросе', async () => {
  let requests = 0;
  await withServer((_req, res) => {
    requests++;
    res.writeHead(HTTP_NOT_FOUND).end('Not found');
  }, async url => {
    await assert.rejects(measure(url), {
      message: `Запрос 1/${REQUEST_COUNT}: HTTP ${HTTP_NOT_FOUND}`,
    });
    assert.equal(requests, 1);
  });
});

test('таймаут распространяется на чтение тела', async () => {
  await withServer((_req, res) => res.write('unfinished'), async url => {
    await assert.rejects(measure(url, TEST_TIMEOUT_MS), error => {
      assert.ok(error.message.startsWith(`Запрос 1/${REQUEST_COUNT}:`));
      assert.match(error.cause.name, /AbortError|TimeoutError/);
      return true;
    });
  });
});

test('обрыв тела не считается успешной загрузкой', async () => {
  let requests = 0;
  await withServer((_req, res) => {
    requests++;
    res.writeHead(HTTP_OK, { 'Content-Length': String(DECLARED_BODY_BYTES) });
    res.write('short');
    setTimeout(() => res.destroy(), DISCONNECT_DELAY_MS);
  }, async url => {
    await assert.rejects(measure(url), error => {
      assert.ok(error.message.startsWith(`Запрос 1/${REQUEST_COUNT}:`));
      assert.ok(error.cause instanceof Error);
      return true;
    });
    assert.equal(requests, 1);
  });
});

test('пустой ответ даёт нулевой объём и скорость', async () => {
  await withServer((_req, res) => res.writeHead(HTTP_NO_CONTENT).end(), async url => {
    const result = await measure(url);
    assert.equal(result.totalBytes, 0);
    assert.equal(result.speedMbps, 0);
  });
});

test('перенаправление приводит к чтению конечного тела', async () => {
  let files = 0;
  await withServer((req, res) => {
    if (req.url === '/') res.writeHead(HTTP_REDIRECT, { Location: '/file' }).end();
    else {
      files++;
      res.end(SMALL_BODY);
    }
  }, async url => {
    assert.equal((await measure(url)).totalBytes, Buffer.byteLength(SMALL_BODY) * REQUEST_COUNT);
    assert.equal(files, REQUEST_COUNT);
  });
});

test('неверный адрес и неподдерживаемый протокол отклоняются', async () => {
  await assert.rejects(measure('not-a-url'), { code: 'ERR_INVALID_URL' });
  await assert.rejects(measure('file:///tmp/file'), {
    message: 'Адрес должен начинаться с http:// или https://',
  });
});

test('CLI выводит результат и возвращает код 1 при отсутствии URL', async () => {
  const script = fileURLToPath(new URL('./speed-test.mjs', import.meta.url));
  await withServer((_req, res) => res.end(SMALL_BODY), async url => {
    const child = spawn(process.execPath, [script, url], { timeout: CHILD_PROCESS_TIMEOUT_MS });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    assert.equal(code, 0, stderr);
    assert.ok(stdout.includes(`Выполнено запросов: ${REQUEST_COUNT}`));
    assert.ok(stdout.includes(`Общий объём данных: ${Buffer.byteLength(SMALL_BODY) * REQUEST_COUNT} байт`));
    assert.match(stdout, new RegExp(`Скорость скачивания: \\d+\\.\\d{${OUTPUT_DECIMAL_PLACES}} Мбит/с`));
  });
  const missing = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: CHILD_PROCESS_TIMEOUT_MS });
  assert.equal(missing.status, ERROR_EXIT_CODE);
  assert.match(missing.stderr, /Запуск:/);
  assert.equal(missing.stdout, '');
});
