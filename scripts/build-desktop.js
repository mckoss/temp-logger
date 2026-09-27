import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.platform !== 'darwin') throw new Error('The desktop window requires macOS');
const { version, config } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const bundle = join(root, 'dist', 'Temp Logger.app', 'Contents');
mkdirSync(join(bundle, 'MacOS'), { recursive: true });
execFileSync('/usr/bin/xcrun', ['clang', join(root, 'native', 'TemperatureStatus.c'), '-o', join(root, 'dist', 'temperature-status'), '-framework', 'IOKit', '-framework', 'CoreFoundation'], { stdio: 'inherit' });
execFileSync('/usr/bin/xcrun', ['clang', join(root, 'native', 'PowerStatus.c'), '-o', join(root, 'dist', 'power-status'), '-framework', 'IOKit', '-framework', 'CoreFoundation'], { stdio: 'inherit' });
execFileSync('/usr/bin/xcrun', ['swiftc', join(root, 'native', 'ThermalStatus.swift'), '-o', join(root, 'dist', 'thermal-status'), '-framework', 'Foundation'], { stdio: 'inherit' });
execFileSync('/usr/bin/xcrun', ['swiftc', join(root, 'native', 'TempLogger.swift'), '-o', join(bundle, 'MacOS', 'TempLogger'), '-framework', 'Cocoa', '-framework', 'WebKit'], { stdio: 'inherit' });
writeFileSync(join(bundle, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>TempLogger</string>
<key>CFBundleIdentifier</key><string>com.mckoss.temp-logger.window</string>
<key>CFBundleName</key><string>Temp Logger</string>
<key>CFBundleDisplayName</key><string>Temp Logger</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>TempLoggerURL</key><string>http://127.0.0.1:${config.port}</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>`);
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', dirname(bundle)], { stdio: 'inherit' });
console.log(`Built ${dirname(bundle)}`);
