import { pathToFileURL } from 'node:url';

import {
  BITS_PER_BYTE,
  MILLISECONDS_PER_SECOND,
  BITS_PER_MEGABIT,
  REQUEST_COUNT,
  DEFAULT_TIMEOUT_MS,
  EXPECTED_ARGUMENT_COUNT,
  OUTPUT_DECIMAL_PLACES,
  ERROR_EXIT_CODE,
} from './constants.mjs';

export async function measure(address, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Адрес должен начинаться с http:// или https://');
  }

  let totalBytes = 0;
  let totalMs = 0;

  for (let i = 0; i < REQUEST_COUNT; i++) {
    const start = performance.now();
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }

      let bytes = 0;
      if (response.body) {
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
        }
      }
      totalMs += performance.now() - start;
      totalBytes += bytes;
    } catch (error) {
      throw new Error(`Запрос ${i + 1}/${REQUEST_COUNT}: ${error.message}`, { cause: error });
    }
  }

  const totalBits = totalBytes * BITS_PER_BYTE;
  const totalSeconds = totalMs / MILLISECONDS_PER_SECOND;

  return {
    averageMs: totalMs / REQUEST_COUNT,
    totalBytes,
    speedMbps: totalBits / totalSeconds / BITS_PER_MEGABIT,
  };
}

const [, scriptPath, ...args] = process.argv;

if (scriptPath && import.meta.url === pathToFileURL(scriptPath).href) {
  try {
    if (args.length !== EXPECTED_ARGUMENT_COUNT) {
      throw new Error('Запуск: node speed-test.mjs "https://example.com/large-file.jpg"');
    }
    const [address] = args;
    const result = await measure(address);
    console.log(`Выполнено запросов: ${REQUEST_COUNT}`);
    console.log(`Среднее время запроса: ${result.averageMs.toFixed(OUTPUT_DECIMAL_PLACES)} мс`);
    console.log(`Общий объём данных: ${result.totalBytes} байт`);
    console.log(`Скорость скачивания: ${result.speedMbps.toFixed(OUTPUT_DECIMAL_PLACES)} Мбит/с`);
  } catch (error) {
    console.error(`Ошибка: ${error.message}`);
    process.exitCode = ERROR_EXIT_CODE;
  }
}
