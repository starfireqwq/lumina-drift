import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = fileURLToPath(new URL('../', import.meta.url));
const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME ||
  path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
const tools = path.join(sdk, 'build-tools', '36.0.0');
const platform = path.join(sdk, 'platforms', 'android-36', 'android.jar');
const javaBin = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin') : '';
const javaTool = (name) => javaBin ? path.join(javaBin, name + '.exe') : name;
const version = JSON.parse(fs.readFileSync(path.join(root, 'apps/client/package.json'), 'utf8')).version;
const out = path.resolve(process.argv[2] || path.join(root, 'apps/client/release', version));
const web = path.resolve(process.argv[3] || path.join(root, 'apps/client/dist'));
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-android-'));
const native = path.join(root, 'apps/client/android');
const [major, minor, patch] = version.split('.').map(Number);
const versionCode = major * 10000 + minor * 100 + patch;
const run = (exe, args, options = {}) => execFileSync(exe, args, { stdio: 'inherit', ...options });
for (const dir of ['assets/web', 'res/drawable', 'classes', 'dex']) fs.mkdirSync(path.join(stage, dir), { recursive: true });
if (!fs.existsSync(platform) || !fs.existsSync(path.join(tools, 'aapt2.exe'))) {
  throw new Error('Install Android SDK platform android-36 and build-tools 36.0.0 first.');
}
fs.cpSync(web, path.join(stage, 'assets/web'), { recursive: true });
fs.copyFileSync(path.join(native, 'android-bridge.js'), path.join(stage, 'assets/web/android-bridge.js'));
const indexPath = path.join(stage, 'assets/web/index.html');
fs.writeFileSync(indexPath, fs.readFileSync(indexPath, 'utf8').replace('<head>', '<head>\n    <script src="./android-bridge.js"></script>'));
fs.copyFileSync(path.join(root, 'apps/client/resources/icon.png'), path.join(stage, 'res/drawable/icon.png'));
run(path.join(tools, 'aapt2.exe'), ['compile', '--dir', path.join(stage, 'res'), '-o', path.join(stage, 'resources.zip')]);
const resources = path.join(stage, 'resources.apk');
run(path.join(tools, 'aapt2.exe'), [
  'link', '-o', resources, '-I', platform, '--manifest', path.join(native, 'AndroidManifest.xml'),
  '--min-sdk-version', '26', '--target-sdk-version', '35',
  '--version-code', String(versionCode), '--version-name', version, '-A', path.join(stage, 'assets'), path.join(stage, 'resources.zip'),
]);
const sourceDir = path.join(native, 'src/com/luminadrift/paint');
run(javaTool('javac'), [
  '--release', '8', '-encoding', 'UTF-8', '-classpath', platform, '-d', path.join(stage, 'classes'),
  ...fs.readdirSync(sourceDir).filter(name => name.endsWith('.java')).map(name => path.join(sourceDir, name)),
]);
const classFiles = fs.readdirSync(path.join(stage, 'classes/com/luminadrift/paint'))
  .filter(name => name.endsWith('.class')).map(name => path.join(stage, 'classes/com/luminadrift/paint', name));
run(javaTool('java'), [
  '-cp', path.join(tools, 'lib/d8.jar'), 'com.android.tools.r8.D8',
  '--release', '--min-api', '26', '--lib', platform, '--output', path.join(stage, 'dex'), ...classFiles,
]);
const archive = await JSZip.loadAsync(fs.readFileSync(resources));
for (const entry of Object.values(archive.files)) {
  if (!entry.name.includes('\\')) continue;
  archive.file(entry.name.replaceAll('\\', '/'), await entry.async('nodebuffer'));
  archive.remove(entry.name);
}
archive.file('classes.dex', fs.readFileSync(path.join(stage, 'dex/classes.dex')));
const arscEntry = archive.file('resources.arsc');
if (arscEntry) {
  // Android 11+ (API 30+, targetSdk 35) rejects APKs whose resources.arsc is compressed.
  archive.file('resources.arsc', await arscEntry.async('nodebuffer'), { compression: 'STORE' });
}
for (const entry of Object.values(archive.files)) {
  if (entry.dir || entry.name === 'resources.arsc') continue;
  entry.options.compression = 'DEFLATE';
}
const unsigned = path.join(stage, 'unsigned.apk');
fs.writeFileSync(unsigned, await archive.generateAsync({ type: 'nodebuffer' }));
const aligned = path.join(stage, 'aligned.apk');
run(path.join(tools, 'zipalign.exe'), ['-f', '-p', '4', unsigned, aligned]);

// Keep one signing identity for updates. Its password is protected by Windows DPAPI.
const signingDir = path.join(process.env.LOCALAPPDATA || os.homedir(), 'LuminaDrift/signing');
fs.mkdirSync(signingDir, { recursive: true });
const key = path.join(signingDir, 'android-release.p12');
const secret = path.join(signingDir, 'android-release.password');
const protect = `
  $ErrorActionPreference='Stop'
  Add-Type -AssemblyName System.Security
  $scope=[System.Security.Cryptography.DataProtectionScope]::CurrentUser
  if ($env:LUMINA_NEW_SIGNING_PASSWORD) {
    $bytes=[Text.Encoding]::UTF8.GetBytes($env:LUMINA_NEW_SIGNING_PASSWORD)
    $protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,$scope)
    [IO.File]::WriteAllText($env:LUMINA_SIGNING_PASSWORD_FILE,[Convert]::ToBase64String($protected))
  } else {
    $bytes=[Convert]::FromBase64String([IO.File]::ReadAllText($env:LUMINA_SIGNING_PASSWORD_FILE))
    [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,$scope))
  }
`;
const keyEnv = { ...process.env, LUMINA_SIGNING_PASSWORD_FILE: secret };
let password;
if (!fs.existsSync(key)) {
  password = crypto.randomBytes(32).toString('hex');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', protect], {
    env: { ...keyEnv, LUMINA_NEW_SIGNING_PASSWORD: password }, stdio: 'pipe',
  });
  run(javaTool('keytool'), [
    '-genkeypair', '-keystore', key, '-storetype', 'PKCS12', '-alias', 'lumina-release',
    '-storepass:env', 'LUMINA_SIGNING_PASSWORD', '-keyalg', 'RSA', '-keysize', '3072',
    '-validity', '10000', '-dname', 'CN=Lumina Drift, O=Lumina Drift',
  ], { env: { ...process.env, LUMINA_SIGNING_PASSWORD: password } });
} else {
  password = execFileSync('powershell.exe', ['-NoProfile', '-Command', protect], { env: keyEnv, encoding: 'utf8' }).trim();
}
fs.mkdirSync(out, { recursive: true });
const target = path.join(out, `Lumina-Drift-Paint-Android-${version}.apk`);
run(javaTool('java'), [
  '-jar', path.join(tools, 'lib/apksigner.jar'), 'sign', '--ks', key,
  '--ks-key-alias', 'lumina-release', '--ks-pass', 'env:LUMINA_SIGNING_PASSWORD', '--out', target, aligned,
], { env: { ...process.env, LUMINA_SIGNING_PASSWORD: password } });
run(javaTool('java'), ['-jar', path.join(tools, 'lib/apksigner.jar'), 'verify', '--verbose', target]);
console.log(target);
