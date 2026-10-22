#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { postJson } from './http.mjs';
import { installSkill, skillDestination, skillStatus } from './skill.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home =
  process.env.TEACH_ME_AGENT_HOME ||
  path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'teach-me-agent-v2');
const args = process.argv.slice(2);
let command = args.shift() || 'help';
const flags = {};
const words = [];
let argumentError;
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    if (['all', 'json', 'help', 'version'].includes(key)) flags[key] = true;
    else if (!args[i + 1] || args[i + 1].startsWith('--')) {
      argumentError = `--${key} 需要一个值`;
      break;
    } else flags[key] = args[++i];
  } else words.push(args[i]);
}
if (['--help', '-h'].includes(command) || flags.help) command = 'help';
if (['--version', '-v'].includes(command) || flags.version) command = 'version';
const endpointFile = path.join(home, 'endpoint.json');
const client = String(
  flags.client || process.env.TEACH_ME_CLIENT || process.env.CODEX_THREAD_ID || 'default',
);
const driverFile = path.join(
  home,
  'clients',
  createHash('sha256').update(client).digest('hex') + '.json',
);
async function saveDriver() {
  await fs.mkdir(path.dirname(driverFile), { recursive: true });
  await fs.writeFile(driverFile, JSON.stringify(driver), { mode: 0o600 });
}
const read = async (file) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let endpoint = await read(endpointFile);
let driver = await read(driverFile);
async function call(route, data = {}, timeout = 30000) {
  if (!endpoint) throw new Error('应用未启动。先运行 start。');
  return postJson(
    endpoint.port,
    route,
    {
      'x-companion-token': endpoint.token,
      ...(driver ? { 'x-session-token': driver.token } : {}),
    },
    data,
    timeout,
  );
}
async function alive(timeout = 30000) {
  try {
    await call('status', {}, timeout);
    return true;
  } catch {
    return false;
  }
}
const out = (value) =>
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
try {
  if (argumentError) throw new Error(argumentError);
  if (command === 'version')
    out(JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version);
  else if (command === 'protocol')
    out(await fs.readFile(path.join(root, 'docs/AGENT-PROTOCOL.md'), 'utf8'));
  else if (command === 'skill' || command === 'install-skill') {
    const unknown = Object.keys(flags).find((key) => !['agent', 'skills-dir'].includes(key));
    if (unknown) throw new Error(`不支持的 skill 参数：--${unknown}`);
    if (words.length > (command === 'skill' ? 1 : 0)) throw new Error('skill 命令有多余参数');
    const verb = command === 'install-skill' ? 'install' : words[0] || 'status';
    if (flags.agent && flags.agent !== 'codex')
      throw new Error('当前内置安装目标为 codex；其他兼容宿主请使用 --skills-dir 明确指定目录。');
    const options = {
      source: path.join(root, 'skills/teach-me/SKILL.md'),
      destination: skillDestination({ skillsDir: flags['skills-dir'] }),
    };
    if (verb === 'path') out(options.destination);
    else if (verb === 'status') out(await skillStatus(options));
    else if (verb === 'install') {
      const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
      out({
        ...(await installSkill({ ...options, version })),
        next: "Reload your Agent skills or open a new session, then invoke the teach-me skill using your host's loading rules.",
      });
    } else
      throw new Error('用法：tma skill install|status|path [--agent codex] [--skills-dir 目录]');
  } else if (command === 'help') {
    out(
      `Teach me, Agent - guide without taking control.

Usage: tma <command> [options]
Aliases: teach-me-agent / node bin/teach-me.mjs

Commands:
  start [--topic TOPIC] [--display ID]  Start the App and a teaching session
  attach --session ID                 Request access to an existing session
  wait [--timeout SECONDS]             Wait for user messages (default: 480)
  say TEXT                            Send a short message to the panel
  show JSON_OR_FILE                   Show annotations; requires a nonempty say
  capture                             Take a screenshot with user approval
  zoom --shot ID --rect x,y,w,h        Crop the same screenshot frame
  clear [--all]                       Clear Agent annotations; all also clears user drawings
  board / status                      Inspect the board or session status
  stop                                Close the App
  skill install                       Install or update the teaching skill
  skill status / path                 Inspect skill status or destination
  protocol                            Print the full Agent protocol
  --help, -h                          Show this help
  --version, -v                       Print the version

Use --client NAME on session commands to identify each Agent.
Use --skills-dir DIR to install into your Agent's skills directory.
The optional --agent codex flag selects the built-in location preset.
Default skill directory: CODEX_HOME/skills or ~/.codex/skills.

Example scene: {"say":"Click here","pattern":"point","to":[100,100]}
Coordinates are pixels in the latest screenshot. Open each returned image
path with your Agent's image tool.`,
    );
  } else if (command === 'start') {
    let secret = '';
    if (!(await alive())) {
      await fs.mkdir(home, { recursive: true });
      await fs.access(path.join(root, 'dist/host/main.cjs')).catch(() => {
        throw new Error('请先运行 npm run build');
      });
      secret = randomUUID();
      const env = { ...process.env, TMA_LAUNCH_SECRET: secret };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(require('electron'), [root], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env,
      });
      child.on('error', () => {});
      child.unref();
      // Allow two 10s native startup attempts, confirmed retirement (up to 2s),
      // then the first 10s window operation and Electron initialization overhead.
      const launchDeadline = Date.now() + 45000;
      let available = false;
      while (Date.now() < launchDeadline) {
        await pause(Math.min(150, launchDeadline - Date.now()));
        endpoint = await read(endpointFile);
        const remaining = launchDeadline - Date.now();
        if (remaining <= 0) break;
        if (await alive(Math.min(1000, remaining))) {
          available = true;
          break;
        }
      }
      if (!available) throw new Error('Electron 未能启动，请运行 npm run app 查看错误。');
    }
    driver = await call(
      'start',
      {
        topic: flags.topic || '',
        launchSecret: secret,
        displayId: flags.display ? Number(flags.display) : undefined,
      },
      65000,
    );
    await saveDriver();
    out(driver);
  } else if (command === 'attach') {
    driver = await call('attach', { session: flags.session }, 65000);
    await saveDriver();
    out(driver);
  } else if (command === 'wait') {
    const seconds = Number(flags.timeout ?? 480);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 480)
      throw new Error('timeout 必须在 1–480 秒之间');
    const result = await call('wait', { timeoutMs: seconds * 1000 }, seconds * 1000 + 10000);
    // Print before ack: a process killed before this output will redeliver.
    await new Promise((resolve, reject) =>
      process.stdout.write(JSON.stringify(result, null, 2) + '\n', (err) =>
        err ? reject(err) : resolve(),
      ),
    );
    if (result.messages?.length)
      await call('ack', { id: Math.max(...result.messages.map((m) => m.id)) });
  } else if (command === 'say') out(await call('say', { text: words.join(' ') }));
  else if (command === 'show') {
    let text = words.join(' ');
    if (!text.trim().startsWith('{')) text = await fs.readFile(text, 'utf8');
    out(await call('show', JSON.parse(text)));
  } else if (command === 'zoom') {
    if (typeof flags.rect !== 'string') throw new Error('zoom 需要 --rect x,y,w,h');
    out(await call('zoom', { shot: flags.shot, rect: flags.rect.split(',').map(Number) }));
  } else if (command === 'clear') out(await call('clear', { all: !!flags.all }));
  else if (['status', 'board', 'capture', 'stop'].includes(command))
    out(await call(command, {}, command === 'capture' ? 100000 : 30000));
  else throw new Error(`未知命令：${command}`);
} catch (e) {
  console.error(`tma: ${e.message}`);
  process.exitCode = 1;
}
