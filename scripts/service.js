// Per-user launchd agents: one supervised logger and one window opened at login.
import { mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { config } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const domain = `gui/${process.getuid()}`;
const loggerLabel = 'com.mckoss.temp-logger';
const windowLabel = `${loggerLabel}.window`;
const agents = join(homedir(), 'Library', 'LaunchAgents');
const logs = join(homedir(), 'Library', 'Logs', 'temp-logger');
const appPath = join(homedir(), 'Applications', 'Temp Logger.app');
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const string = value => `<string>${xml(value)}</string>`;
const command = (args, options = {}) => execFileSync('/bin/launchctl', args, { stdio: 'inherit', ...options });
const unload = label => spawnSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
function plist(label, args, keepAlive) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(label)}
<key>ProgramArguments</key><array>${args.map(string).join('')}</array>
<key>WorkingDirectory</key>${string(root)}
<key>RunAtLoad</key><true/>
<key>KeepAlive</key>${keepAlive === 'on-failure' ? '<dict><key>SuccessfulExit</key><false/></dict>' : '<true/>'}
<key>ThrottleInterval</key><integer>10</integer>
<key>EnvironmentVariables</key><dict><key>HOST</key><string>127.0.0.1</string><key>PORT</key>${string(config.port)}<key>INTERVAL_MS</key><string>300000</string><key>DB_PATH</key>${string(join(root, 'data', 'temps.db'))}</dict>
<key>StandardOutPath</key>${string(join(logs, `${label}.log`))}
<key>StandardErrorPath</key>${string(join(logs, `${label}.error.log`))}
</dict></plist>`;
}

if (process.platform !== 'darwin') throw new Error('The login service requires macOS');
const action = process.argv[2] || 'status';
if (action === 'install') {
  const built = join(root, 'dist', 'Temp Logger.app');
  if (!existsSync(built)) throw new Error('Run npm run build:desktop first');
  mkdirSync(agents, { recursive: true });
  mkdirSync(logs, { recursive: true });
  mkdirSync(dirname(appPath), { recursive: true });
  // Refuse to replace an unrelated application with the same name.
  if (existsSync(appPath)) {
    const info = readFileSync(join(appPath, 'Contents', 'Info.plist'), 'utf8');
    if (!info.includes(windowLabel)) throw new Error(`An unrelated app already exists at ${appPath}`);
  }
  unload(windowLabel);
  unload(loggerLabel);
  cpSync(built, appPath, { recursive: true });
  for (const [label, args, keepAlive] of [
    [loggerLabel, [process.execPath, join(root, 'server.js')], true],
    [windowLabel, [join(appPath, 'Contents', 'MacOS', 'TempLogger')], 'on-failure'],
  ]) {
    const path = join(agents, `${label}.plist`);
    writeFileSync(path, plist(label, args, keepAlive));
    execFileSync('/usr/bin/plutil', ['-lint', path], { stdio: 'inherit' });
    command(['enable', `${domain}/${label}`]);
    command(['bootstrap', domain, path]);
  }
  console.log(`Installed login service and ${appPath}. Logs: ${logs}`);
} else if (action === 'uninstall') {
  for (const label of [windowLabel, loggerLabel]) {
    unload(label);
    rmSync(join(agents, `${label}.plist`), { force: true });
  }
  console.log('Stopped login agents. App, database, and logs retained.');
} else if (action === 'open') {
  execFileSync('/usr/bin/open', [appPath], { stdio: 'inherit' });
} else if (action === 'status') {
  command(['print', `${domain}/${loggerLabel}`]);
} else {
  throw new Error('Usage: node scripts/service.js install|uninstall|open|status');
}
