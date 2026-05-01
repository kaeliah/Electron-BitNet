import { execFile, spawn } from 'child_process';
import path from 'path';
import os from 'os';
import process from 'process';
import fs from 'fs';
import crypto from 'crypto';
import http from 'http';
import url from "url";
import { readFile } from 'fs/promises';
import mime from 'mime-types';

import { app, BrowserWindow, Menu, Tray, ipcMain, shell, protocol, dialog, clipboard } from "electron";

import { initApplicationMenu } from "./lib/applicationMenu.js";

let mainWindow = null;
let tray = null;
let inferenceProcess = null;
let benchmarkProcess = null;
let perplexityProcess = null;
let apiServerProcess = null;
let apiProxyServer = null;
let appLogPath = null;

const LOCAL_API_DEFAULTS = {
  host: '127.0.0.1',
  port: 5272,
  proxyPort: 5273,
  modelAlias: 'bitnet-local',
  ctxSize: 4096,
  threads: Math.max(1, Math.min(8, os.cpus().length)),
  nPredict: 1024,
  temperature: 0.7,
  autoStart: true,
};

function ensureAppLogPath() {
  if (appLogPath) {
    return appLogPath;
  }

  try {
    const baseDir = app.isReady()
      ? app.getPath('userData')
      : path.join(os.tmpdir(), 'ElectronBitnet');
    fs.mkdirSync(baseDir, { recursive: true });
    appLogPath = path.join(baseDir, 'main.log');
  } catch (error) {
    appLogPath = path.join(os.tmpdir(), 'ElectronBitnet-main.log');
  }

  return appLogPath;
}

function logLine(level, message, details = "") {
  const line = `[${new Date().toISOString()}] [${level}] ${message}${details ? ` ${details}` : ''}`;
  if (level === 'ERROR') {
    console.error(line);
  } else {
    console.log(line);
  }

  try {
    fs.appendFileSync(ensureAppLogPath(), `${line}\n`, 'utf8');
  } catch (error) {
    // Avoid recursive logging if filesystem access is the problem.
  }
}

logLine('INFO', 'Main process module loaded');

function getLocalApiConfigPath() {
  return path.join(app.getPath('userData'), 'local-api.json');
}

function getLocalApiBaseUrl(config) {
  return `http://${config.host}:${config.port}`;
}

function readLocalApiConfig() {
  const configPath = getLocalApiConfigPath();
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    logLine('ERROR', 'Failed to parse local API config:', error.stack || error.message);
    return null;
  }
}

function writeLocalApiConfig(config) {
  const configPath = getLocalApiConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function ensureLocalApiConfig() {
  const existingConfig = readLocalApiConfig() || {};
  const mergedConfig = {
    ...LOCAL_API_DEFAULTS,
    ...existingConfig,
  };

  if (!mergedConfig.apiKey) {
    mergedConfig.apiKey = crypto.randomBytes(24).toString('hex');
  }

  writeLocalApiConfig(mergedConfig);
  return mergedConfig;
}

function getLocalApiPublicConfig() {
  const config = ensureLocalApiConfig();
  return {
    ...config,
    baseUrl: getLocalApiBaseUrl(config),
    proxyBaseUrl: `http://${config.host}:${config.proxyPort}`,
    chatCompletionsUrl: `${getLocalApiBaseUrl(config)}/v1/chat/completions`,
    proxyChatCompletionsUrl: `http://${config.host}:${config.proxyPort}/v1/chat/completions`,
    modelsUrl: `${getLocalApiBaseUrl(config)}/v1/models`,
    proxyModelsUrl: `http://${config.host}:${config.proxyPort}/v1/models`,
    healthUrl: `${getLocalApiBaseUrl(config)}/health`,
    proxyHealthUrl: `http://${config.host}:${config.proxyPort}/health`,
    status: apiServerProcess ? 'starting_or_running' : 'stopped',
  };
}

function writeCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  response.setHeader('Access-Control-Max-Age', '86400');
}

async function startLocalApiProxyServer() {
  const config = ensureLocalApiConfig();
  if (apiProxyServer) {
    return getLocalApiPublicConfig();
  }

  apiProxyServer = http.createServer(async (request, response) => {
    writeCorsHeaders(response);

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    const requestUrl = request.url || '/';
    const allowedPaths = new Set([
      '/health',
      '/v1/models',
      '/v1/chat/completions',
    ]);

    const parsedUrl = new URL(requestUrl, `http://${config.host}:${config.proxyPort}`);
    if (!allowedPaths.has(parsedUrl.pathname)) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    try {
      const bodyChunks = [];
      for await (const chunk of request) {
        bodyChunks.push(chunk);
      }

      const rawBody = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : undefined;
      const upstreamUrl = `${getLocalApiBaseUrl(config)}${parsedUrl.pathname}${parsedUrl.search}`;
      const upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers: {
          'Content-Type': request.headers['content-type'] || 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: request.method === 'GET' ? undefined : rawBody,
      });

      response.writeHead(upstreamResponse.status, {
        'Content-Type': upstreamResponse.headers.get('content-type') || 'application/json',
      });

      const arrayBuffer = await upstreamResponse.arrayBuffer();
      response.end(Buffer.from(arrayBuffer));
    } catch (error) {
      console.error('Local API proxy error:', error);
      response.writeHead(502, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        error: 'Upstream request failed',
        details: error.message,
      }));
    }
  });

  await new Promise((resolve, reject) => {
    apiProxyServer.once('error', reject);
    apiProxyServer.listen(config.proxyPort, config.host, () => {
      apiProxyServer.off('error', reject);
      resolve();
    });
  });

  return getLocalApiPublicConfig();
}

function stopLocalApiProxyServer() {
  if (!apiProxyServer) {
    return false;
  }

  apiProxyServer.close();
  apiProxyServer = null;
  return true;
}

function getServerBinaryPath() {
  const candidatePaths = [
    path.join(app.getAppPath(), 'bin', 'Release', 'llama-server.exe'),
    path.join(process.resourcesPath, 'bin', 'Release', 'llama-server.exe'),
  ];

  return candidatePaths.find((candidate) => fs.existsSync(candidate)) || "";
}

async function waitForLocalApiReady(config, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  const targets = [
    `${getLocalApiBaseUrl(config)}/health`,
    `${getLocalApiBaseUrl(config)}/v1/models`,
  ];

  while (Date.now() < deadline) {
    for (const target of targets) {
      try {
        const response = await fetch(target, {
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
          },
        });

        if (response.ok) {
          return true;
        }
      } catch (error) {
        // Server may still be starting.
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 750));
  }

  return false;
}

async function startLocalApiServer() {
  const config = ensureLocalApiConfig();
  const modelPath = getBundledModelPath();
  const serverPath = getServerBinaryPath();

  if (!modelPath) {
    throw new Error('Bundled model not found for local API server.');
  }

  if (!serverPath) {
    throw new Error('llama-server.exe not found.');
  }

  if (apiServerProcess) {
    return getLocalApiPublicConfig();
  }

  const commandArgs = [
    '-m', modelPath,
    '--host', config.host,
    '--port', String(config.port),
    '-c', String(config.ctxSize),
    '-t', String(config.threads),
    '-n', String(config.nPredict),
    '--temp', String(config.temperature),
    '--api-key', config.apiKey,
    '--alias', config.modelAlias,
    '--metrics',
    '--slots',
    '-cb',
    '-ngl', '0',
  ];

  apiServerProcess = spawn(serverPath, commandArgs, {
    windowsHide: true,
  });

  apiServerProcess.stdout.on('data', (data) => {
    logLine('INFO', '[local-api]', data.toString().trim());
  });

  apiServerProcess.stderr.on('data', (data) => {
    logLine('ERROR', '[local-api]', data.toString().trim());
  });

  apiServerProcess.on('close', (code) => {
    logLine('INFO', `Local API server exited with code ${code}`);
    apiServerProcess = null;
  });

  apiServerProcess.on('error', (error) => {
    logLine('ERROR', 'Local API server failed to start:', error.stack || error.message);
    apiServerProcess = null;
  });

  const ready = await waitForLocalApiReady(config);
  if (!ready) {
    const pid = apiServerProcess?.pid;
    if (apiServerProcess) {
      apiServerProcess.kill('SIGKILL');
      apiServerProcess = null;
    }
    throw new Error(`Local API server did not become ready in time${pid ? ` (PID ${pid})` : ''}.`);
  }

  await startLocalApiProxyServer();

  return getLocalApiPublicConfig();
}

function stopLocalApiServer() {
  stopLocalApiProxyServer();
  if (!apiServerProcess) {
    return false;
  }

  try {
    apiServerProcess.kill('SIGKILL');
  } catch (error) {
    console.error('Failed to stop local API server:', error);
  } finally {
    apiServerProcess = null;
  }

  return true;
}

function regenerateLocalApiKey() {
  const config = ensureLocalApiConfig();
  config.apiKey = crypto.randomBytes(24).toString('hex');
  writeLocalApiConfig(config);
  return config;
}

function getBundledModelPath() {
  const candidatePaths = [];

  if (app.isPackaged) {
    candidatePaths.push(
      path.join(process.resourcesPath, 'models', 'BitNet-b1.58-2B-4T', 'ggml-model-i2_s.gguf'),
      path.join(process.resourcesPath, 'app', 'models', 'BitNet-b1.58-2B-4T', 'ggml-model-i2_s.gguf')
    );
  } else {
    candidatePaths.push(
      path.join(app.getAppPath(), '..', 'BitNet', 'models', 'BitNet-b1.58-2B-4T', 'ggml-model-i2_s.gguf'),
      path.join(app.getAppPath(), 'models', 'BitNet-b1.58-2B-4T', 'ggml-model-i2_s.gguf')
    );
  }

  return candidatePaths.find((candidate) => fs.existsSync(candidate)) || "";
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  }
]);

function sendInstructPrompt(promptText) {
  if (inferenceProcess && inferenceProcess.stdin && !inferenceProcess.stdin.destroyed) {
    try {
      // llama.cpp expects prompts ending with newline in interactive mode
      inferenceProcess.stdin.write(promptText + '\n');
      console.log('Sent prompt to instruction process:', promptText);
    } catch (error) {
      console.error('Failed to write to instruction process stdin:', error);
      mainWindow.webContents.send('aiError', 'Failed to send prompt to AI.');
      terminateInference(); // Stop if we can't communicate
    }
  } else {
    console.warn('Attempted to send prompt, but instruction process stdin is not available.');
    mainWindow.webContents.send('aiError', 'AI process is not running or not ready for input.');
  }
}

function terminateInference() {
  if (inferenceProcess) {
    console.log('Terminating inference process...');
    const pid = inferenceProcess.pid; // Get PID before killing
    try {
        // Check if it's a spawned process (has stdin property)
        if (inferenceProcess.stdin) {
            inferenceProcess.stdout?.removeAllListeners();
            inferenceProcess.stderr?.removeAllListeners();
            inferenceProcess.removeAllListeners('close');
            inferenceProcess.removeAllListeners('error');
        }
        // Force kill works for both spawn and execFile child processes
        inferenceProcess.kill('SIGKILL');
        console.log(`Inference process (PID: ${pid}) terminated.`);
    } catch (error) {
      console.error(`Failed to terminate inference process (PID: ${pid}):`, error);
    } finally {
       inferenceProcess = null;
       // Ensure the frontend knows it stopped, send appropriate completion signal
       if (mainWindow && mainWindow.webContents) {
           // Decide which completion signal based on context, or send a generic one
           mainWindow.webContents.send('aiComplete'); // For original mode
           mainWindow.webContents.send('aiInstructComplete'); // For instruction mode
       }
    }
  } else {
    console.log('No inference process to terminate.');
  }
}

function runBenchmark(args) {
  let benchPath = path.join(app.getAppPath(), 'bin', 'Release', 'llama-bench.exe');

  if (!fs.existsSync(benchPath)) {
    console.error('Benchmark binary not found, please build first.');
    return;
  }

  const commandArgs = [
    '-m', args.model,
    '-n', args.n_token,
    '-ngl', '0',
    '-b', '1',
    '-t', args.threads,
    '-p', args.n_prompt,
    '-r', '5'
  ];

  benchmarkProcess = execFile(benchPath, commandArgs, (error, stdout, stderr) => {
    if (error) {
      console.error(`execFile error: ${error}`);
      return;
    }

    if (stderr) {
      console.error(`stderr: ${stderr}`);
    }

    if (stdout) {
      mainWindow.webContents.send('benchmarkLog', stdout);
    }

    mainWindow.webContents.send('benchmarkComplete');
    benchmarkProcess = null;
  });
}

function terminateBenchmark() {
  if (benchmarkProcess) {
    console.log('Terminating benchmark process...');
    try {
      benchmarkProcess.kill('SIGKILL'); // Use SIGKILL to forcefully terminate the process
      benchmarkProcess.stdout.removeAllListeners('data');
      benchmarkProcess.stderr.removeAllListeners('data');
      benchmarkProcess = null;
      console.log('Benchmark process terminated.');
    } catch (error) {
      console.error('Failed to terminate benchmark process:', error);
    }
  } else {
    console.log('No benchmark process to terminate.');
  }

  mainWindow.webContents.send('benchmarkComplete');
  benchmarkProcess = null;
}

function runPerplexity(args) {
  let perplexityPath = path.join(app.getAppPath(), 'bin', 'Release', 'llama-perplexity.exe');

  if (!fs.existsSync(perplexityPath)) {
    console.error('Perplexity binary not found, please build first.');
    return;
  }

  const commandArgs = [
    '--model', args.model,
    '--prompt', args.prompt,
    '--threads', args.threads,
    '--ctx-size', args.ctx_size,
    '--perplexity',
    '--ppl-stride', args.ppl_stride
  ];

  perplexityProcess = execFile(perplexityPath, commandArgs, (error, stdout, stderr) => {
    if (error) {
      console.error(`execFile error: ${error}`);
      return;
    }

    if (stderr) {
      console.error(`stderr: ${stderr}`);
      mainWindow.webContents.send('perplexityLog', stderr);
    }

    if (stdout) {
      mainWindow.webContents.send('perplexityLog', stdout);
    }

    mainWindow.webContents.send('perplexityComplete');
    perplexityProcess = null;
  });
}

function terminatePerplexity() {
  if (perplexityProcess) {
    console.log('Terminating perplexity process...');
    try {
      perplexityProcess.kill('SIGKILL'); // Use SIGKILL to forcefully terminate the process
      perplexityProcess.stdout.removeAllListeners('data');
      perplexityProcess.stderr.removeAllListeners('data');
      perplexityProcess = null;
      console.log('Perplexity process terminated.');
    } catch (error) {
      console.error('Failed to terminate perplexity process:', error);
    }
  } else {
    console.log('No perplexity process to terminate.');
  }

  mainWindow.webContents.send('perplexityComplete');
  perplexityProcess = null;
}

// --- New function to initialize instruction mode ---
function initInstructInference(args) {
  let mainPath = path.join(app.getAppPath(), 'bin', 'Release', 'llama-cli.exe');

  if (!fs.existsSync(mainPath)) {
    mainWindow.webContents.send('aiError', 'llama-cli.exe not found.');
    mainWindow.webContents.send('aiInstructComplete'); // Use a specific complete signal if needed
    return;
  }

  // Terminate any existing process first
  terminateInference();

  const commandArgs = [
    '-m', args.model,
    '-n', args.n_predict, // Max tokens per *turn* might need adjustment
    '-t', args.threads,
    '-p', args.prompt, // This is the initial system prompt
    '-ngl', '0',
    '-c', args.ctx_size,
    '--temp', args.temperature,
    '-b', '1',
    '-cnv' // Enable instruction/conversation mode
  ];

  try {
    inferenceProcess = spawn(mainPath, commandArgs);
    mainWindow.webContents.send('aiInstructStarted'); // Signal that it started

    inferenceProcess.stdout.on('data', (data) => {
      mainWindow.webContents.send('aiResponseChunk', data.toString());
    });

    inferenceProcess.stderr.on('data', (data) => {
      console.error(`stderr: ${data}`);
      // Treat stderr as part of the output stream for now
      mainWindow.webContents.send('aiResponseChunk', data.toString());
    });

    inferenceProcess.on('error', (error) => {
      console.error(`spawn error: ${error}`);
      mainWindow.webContents.send('aiError', `Failed to start instruction mode: ${error.message}`);
      mainWindow.webContents.send('aiInstructComplete');
      inferenceProcess = null;
    });

    inferenceProcess.on('close', (code) => {
      console.log(`Instruction process exited with code ${code}`);
      mainWindow.webContents.send('aiInstructComplete'); // Signal completion
      inferenceProcess = null;
    });

  } catch (error) {
      console.error(`Failed to spawn instruction process: ${error}`);
      mainWindow.webContents.send('aiError', `Failed to spawn instruction process: ${error.message}`);
      mainWindow.webContents.send('aiInstructComplete');
      inferenceProcess = null;
  }
}

const createWindow = async () => {
  logLine('INFO', 'Creating main window');
  mainWindow = new BrowserWindow({
    minWidth: 480,
    minHeight: 695,
    maximizable: true,
    useContentSize: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
    icon: __dirname + "/img/taskbar.png",
  });

  initApplicationMenu(mainWindow);
  ensureLocalApiConfig();

  mainWindow.loadURL('file://index.html');

  mainWindow.on('closed', () => {
    logLine('INFO', 'Main window closed');
    mainWindow = null;
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    logLine('ERROR', 'Renderer process gone:', JSON.stringify(details));
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    logLine('ERROR', 'Window failed to load:', `${errorCode} ${errorDescription} ${validatedURL}`);
  });

  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: "deny" };
  });

  tray = new Tray(path.join(__dirname, "img", "tray.png"));
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show App",
      click: function () {
        mainWindow?.show();
      },
    },
    {
      label: "Quit",
      click: function () {
        logLine('INFO', 'Quit requested from tray menu');
        tray = null;
        app.quit();
      },
    },
  ]);

  tray.setToolTip("Electron BitNet");

  tray.on("right-click", (event, bounds) => {
    tray?.popUpContextMenu(contextMenu);
  });

  const safeDomains = [
    "https://github.com",
    "https://react.dev/",
    "https://astro.build/",
    "https://www.electronjs.org/"
  ];

  ipcMain.on("openURL", (event, arg) => {
    try {
      const parsedUrl = new url.URL(arg);
      const domain = parsedUrl.hostname;

      const isSafeDomain = safeDomains.some((safeDomain) => {
        const safeDomainHostname = new url.URL(safeDomain).hostname;
        return safeDomainHostname === domain;
      });

      if (isSafeDomain) {
        shell.openExternal(arg);
      } else {
        console.error(`Rejected opening URL with unsafe domain: ${domain}`);
      }
    } catch (err) {
      console.error(`Failed to open URL: ${err.message}`);
    }
  });

  ipcMain.on("runInference", (event, arg) => {
    let mainPath = path.join(app.getAppPath(), 'bin', 'Release', 'llama-cli.exe');
    if (!fs.existsSync(mainPath)) {
      mainWindow.webContents.send('aiError', 'llama-cli.exe not found.');
      mainWindow.webContents.send('aiComplete');
      return;
    }
    terminateInference(); // Terminate any existing process
    const commandArgs = [ /* ... original args ... */
      '-m', arg.model, '-n', arg.n_predict, '-t', arg.threads, '-p', arg.prompt,
      '-ngl', '0', '-c', arg.ctx_size, '--temp', arg.temperature, '-b', '1'
    ];
    const process = execFile(mainPath, commandArgs, (error, stdout, stderr) => {
      if (inferenceProcess === process) {
          inferenceProcess = null;
          if (error) { console.error(`execFile error: ${error}`); mainWindow.webContents.send('aiError', `Execution Error: ${error.message}`); mainWindow.webContents.send('aiComplete'); return; }
          if (stderr) { console.error(`stderr: ${stderr}`); /* Optionally send stderr */ }
          if (stdout) { mainWindow.webContents.send('aiResponse', stdout); }
          mainWindow.webContents.send('aiComplete');
      }
    });
    inferenceProcess = process; // Store ref
  });

  ipcMain.on("initInstructInference", (event, arg) => { // For interactive start
    initInstructInference(arg);
  });

  ipcMain.on("sendInstructPrompt", (event, promptText) => { // For interactive follow-up
    sendInstructPrompt(promptText);
  });

  ipcMain.on("stopInference", (event) => {
    terminateInference();
  });

  ipcMain.handle('openFileDialog', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'GGUF Files', extensions: ['gguf'] }]
    });
    return result.filePaths;
  });

  ipcMain.handle('getMaxThreads', async () => {
    return os.cpus().length;
  });

  ipcMain.handle('getBundledModelPath', async () => {
    return getBundledModelPath();
  });

  ipcMain.handle('getLocalApiConfig', async () => {
    return getLocalApiPublicConfig();
  });

  ipcMain.handle('startLocalApiServer', async () => {
    return startLocalApiServer();
  });

  ipcMain.handle('stopLocalApiServer', async () => {
    stopLocalApiServer();
    return getLocalApiPublicConfig();
  });

  ipcMain.handle('regenerateLocalApiKey', async () => {
    const config = regenerateLocalApiKey();
    if (apiServerProcess) {
      stopLocalApiServer();
      await startLocalApiServer();
    }
    return {
      ...config,
      baseUrl: getLocalApiBaseUrl(config),
      proxyBaseUrl: `http://${config.host}:${config.proxyPort}`,
      chatCompletionsUrl: `${getLocalApiBaseUrl(config)}/v1/chat/completions`,
      proxyChatCompletionsUrl: `http://${config.host}:${config.proxyPort}/v1/chat/completions`,
      modelsUrl: `${getLocalApiBaseUrl(config)}/v1/models`,
      proxyModelsUrl: `http://${config.host}:${config.proxyPort}/v1/models`,
      healthUrl: `${getLocalApiBaseUrl(config)}/health`,
      proxyHealthUrl: `http://${config.host}:${config.proxyPort}/health`,
      status: apiServerProcess ? 'starting_or_running' : 'stopped',
    };
  });

  ipcMain.on("copyLocalApiEndpoint", () => {
    const config = ensureLocalApiConfig();
    clipboard.writeText(`${getLocalApiBaseUrl(config)}/v1/chat/completions`);
  });

  ipcMain.on("copyLocalApiKey", () => {
    const config = ensureLocalApiConfig();
    clipboard.writeText(config.apiKey);
  });

  ipcMain.on("runBenchmark", (event, arg) => {
    runBenchmark(arg);
  });

  ipcMain.on("stopBenchmark", (event) => {
    terminateBenchmark();
  });

  ipcMain.on("runPerplexity", (event, arg) => {
    runPerplexity(arg);
  });
  
  ipcMain.on("stopPerplexity", (event) => {
    terminatePerplexity();
  });

  tray.on("click", () => {
    mainWindow?.setAlwaysOnTop(true);
    mainWindow?.show();
    mainWindow?.focus();
    mainWindow?.setAlwaysOnTop(false);
  });

  tray.on("balloon-click", () => {
    mainWindow?.setAlwaysOnTop(true);
    mainWindow?.show();
    mainWindow?.focus();
    mainWindow?.setAlwaysOnTop(false);
  });

  const localApiConfig = ensureLocalApiConfig();
  if (localApiConfig.autoStart) {
    startLocalApiServer().catch((error) => {
      logLine('ERROR', 'Failed to auto-start local API server:', error.stack || error.message);
    });
  }
};

process.on('uncaughtException', (error) => {
  logLine('ERROR', 'Uncaught exception:', error.stack || error.message);
});

process.on('unhandledRejection', (reason) => {
  logLine('ERROR', 'Unhandled rejection:', reason?.stack || `${reason}`);
});

const currentOS = os.platform();
if (currentOS === "win32" || currentOS === "linux") {
  // windows + linux setup phase
  const gotTheLock = app.requestSingleInstanceLock();

  if (!gotTheLock) {
    logLine('INFO', 'Single instance lock not acquired, quitting');
    app.quit();
  } else {
    logLine('INFO', 'Single instance lock acquired');
    app.on('second-instance', () => {
      if (!mainWindow) {
        createWindow();
        return;
      }

      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }

      mainWindow.show();
      mainWindow.focus();
    });
  }

  app.whenReady()
    .then(() => {
      app.setAppUserModelId('ElectronBitnet');
      logLine('INFO', 'App ready on Windows/Linux');
      protocol.handle('file', async (req) => {
        const { pathname } = new URL(req.url);
        if (!pathname) {
          return;
        }
        
        let fullPath = process.env.NODE_ENV === "development"
          ? path.join('astroDist', pathname)
          : path.join(process.resourcesPath, 'astroDist', pathname);
      
        if (pathname === '/') {
          fullPath = path.join(fullPath, 'index.html');
        }

        if (fullPath.includes("..") || fullPath.includes("~")) {
          return; // Prevent directory traversal attacks
        }

        let _res;
        try {
          _res = await readFile(fullPath);
        } catch (error) {
          logLine('ERROR', 'Failed to read requested file asset:', error.stack || error.message);
        }

        const mimeType = mime.lookup(fullPath) || 'application/octet-stream';

        return new Response(_res, {
          headers: { 'content-type': mimeType }
        });
      });
    })
    .then(createWindow);

  app.on('before-quit', () => {
    logLine('INFO', 'before-quit received');
    terminateInference();
    terminateBenchmark();
    terminatePerplexity();
    stopLocalApiServer();
  });

  app.on('will-quit', () => {
    logLine('INFO', 'will-quit received');
    terminateInference();
    terminateBenchmark();
    terminatePerplexity();
    stopLocalApiServer();
  });

  app.on("window-all-closed", () => {
    logLine('INFO', 'window-all-closed received');
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    if (mainWindow === null) {
      createWindow();
    }
  });
} else {
  app.whenReady().then(() => {
    protocol.handle('file', async (req) => {
      const { pathname } = new URL(req.url);
      if (!pathname) {
        return;
      }
      
      let fullPath = process.env.NODE_ENV === "development"
        ? path.join('astroDist', pathname)
        : path.join(process.resourcesPath, 'astroDist', pathname);
    
      if (pathname === '/') {
        fullPath = path.join(fullPath, 'index.html');
      }

      if (fullPath.includes("..") || fullPath.includes("~")) {
        return; // Prevent directory traversal attacks
      }

      let _res;
      try {
        _res = await readFile(fullPath);
      } catch (error) {
        console.log({ error });
      }

      const mimeType = mime.lookup(fullPath) || 'application/octet-stream';

      return new Response(_res, {
        headers: { 'content-type': mimeType }
      });
    });
  }).then(createWindow);

  app.on('before-quit', (event) => {
    terminateInference();
    terminateBenchmark();
    terminatePerplexity();
    stopLocalApiServer();
  });
  
  app.on('will-quit', (event) => {
    terminateInference();
    terminateBenchmark();
    terminatePerplexity();
    stopLocalApiServer();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    if (mainWindow === null) {
      createWindow();
    }
  });
}
