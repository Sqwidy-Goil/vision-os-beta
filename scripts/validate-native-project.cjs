const fs = require('fs');
const path = require('path');
const root = process.cwd();
const text = fs.readFileSync('VISI0NSpatial.xcodeproj/project.pbxproj', 'utf8');
function tokenize(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    if (s.startsWith('//', i)) { const n = s.indexOf('\n', i); i = n < 0 ? s.length : n + 1; continue; }
    if (s.startsWith('/*', i)) { const n = s.indexOf('*/', i + 2); if (n < 0) throw Error('unterminated comment'); i = n + 2; continue; }
    if ('{}()=;,'.includes(s[i])) { out.push(s[i++]); continue; }
    if (s[i] === '"') {
      let v = ''; i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\') { i++; const c = s[i++]; v += ({n:'\n',r:'\r',t:'\t'})[c] ?? c; }
        else v += s[i++];
      }
      if (s[i] !== '"') throw Error('unterminated string'); i++; out.push({string:v}); continue;
    }
    let j = i; while (j < s.length && !/[\s{}()=;,]/.test(s[j])) j++;
    out.push(s.slice(i,j)); i = j;
  }
  return out;
}
const tokens = tokenize(text); let p = 0;
function value() {
  const t = tokens[p++];
  if (t === '{') { const o = {}; while (tokens[p] !== '}') { const k = tokens[p++]; if (tokens[p++] !== '=') throw Error('expected ='); o[typeof k === 'object' ? k.string : k] = value(); if (tokens[p] === ';') p++; } p++; return o; }
  if (t === '(') { const a = []; while (tokens[p] !== ')') { a.push(value()); if (tokens[p] === ',') p++; } p++; return a; }
  return typeof t === 'object' ? t.string : t;
}
const project = value();
if (p !== tokens.length) throw Error('trailing pbx content');
const objects = project.objects;
const missing = [];
function filesUnder(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(full)); else result.push(full);
  }
  return result;
}
const included = new Set();
const referencePaths = new Map();
function walkGroup(id, base) {
  const obj = objects[id];
  if (!obj || obj.isa !== 'PBXGroup') return;
  const dir = obj.sourceTree === '<group>' ? path.resolve(base, obj.path || obj.name || '') : base;
  for (const child of obj.children || []) {
    if (!objects[child]) { missing.push(`missing group child ${child}`); continue; }
    const ref = objects[child];
    if (ref.isa === 'PBXGroup') walkGroup(child, dir);
    else if (ref.isa === 'PBXFileReference' && ref.sourceTree === '<group>') {
      const full = path.resolve(dir, ref.path || ref.name || '');
      referencePaths.set(child, full);
      included.add(full);
      if (!fs.existsSync(full)) missing.push(`missing file ${full}`);
    }
  }
}
const rootGroup = objects[project.rootObject]?.mainGroup;
walkGroup(rootGroup, root);
const synchronizedGroups = new Map();
for (const [id, obj] of Object.entries(objects)) {
  if (obj.isa !== 'PBXFileSystemSynchronizedRootGroup') continue;
  const full = path.resolve(root, obj.path || '');
  if (!fs.existsSync(full)) missing.push(`missing synchronized group ${full}`);
  const files = fs.existsSync(full) ? filesUnder(full) : [];
  synchronizedGroups.set(id, {root: full, files});
  for (const file of files) included.add(path.resolve(file));
}
function targetByName(name) {
  return Object.values(objects).find(obj => obj.isa === 'PBXNativeTarget' && obj.name === name);
}
function sourceFilesForTarget(target) {
  const result = new Set();
  for (const phaseID of target.buildPhases || []) {
    const phase = objects[phaseID];
    if (!phase || phase.isa !== 'PBXSourcesBuildPhase') continue;
    for (const buildID of phase.files || []) {
      const build = objects[buildID];
      if (!build) { missing.push(`missing build file ${buildID}`); continue; }
      if (!objects[build.fileRef]) missing.push(`bad build file ${buildID}`);
      const full = referencePaths.get(build.fileRef);
      if (full) result.add(full);
    }
  }
  for (const groupID of target.fileSystemSynchronizedGroups || []) {
    const group = synchronizedGroups.get(groupID);
    if (!group) { missing.push(`target ${target.name} references unknown synchronized group ${groupID}`); continue; }
    for (const file of group.files) if (/\.(swift|metal)$/.test(file)) result.add(path.resolve(file));
  }
  for (const exceptionID of target.membershipExceptions || []) {
    const exception = objects[exceptionID];
    for (const pattern of exception?.membershipExceptions || []) {
      if (/\.(swift|metal)$/.test(pattern)) missing.push(`target ${target.name} excludes source ${pattern}`);
    }
  }
  return result;
}
function requireTargetSources(name, dirs) {
  const target = targetByName(name);
  if (!target) { missing.push(`missing target ${name}`); return; }
  const sources = sourceFilesForTarget(target);
  for (const dir of dirs) {
    for (const file of filesUnder(dir)) {
      if (!/\.(swift|metal)$/.test(file)) continue;
      const full = path.resolve(file);
      if (!included.has(full)) missing.push(`not in project: ${file}`);
      if (!sources.has(full)) missing.push(`not in ${name} Sources: ${file}`);
    }
  }
  return sources;
}
const appDirs = ['App','Core','Interface','Spatial','VR','Modules','Scanning','Tracking'];
const unitDirs = ['tests/VISI0NSpatialTests'];
const uiDirs = ['tests/VISI0NSpatialUITests'];
requireTargetSources('VISI0NSpatial', appDirs);
requireTargetSources('VISI0NSpatialTests', unitDirs);
requireTargetSources('VISI0NSpatialUITests', uiDirs);
function configurationsForTarget(name) {
  const target = targetByName(name);
  const list = target && objects[target.buildConfigurationList];
  return (list?.buildConfigurations || []).map(id => objects[id]).filter(Boolean);
}
const appRelease = configurationsForTarget('VISI0NSpatial').find(config => config.name === 'Release');
if (appRelease?.buildSettings.ENABLE_TESTABILITY !== 'YES') missing.push('app Release must enable testability');
for (const config of configurationsForTarget('VISI0NSpatialTests')) {
  if (config.name === 'Release' && config.buildSettings.TEST_HOST !== '$(BUILT_PRODUCTS_DIR)/VISI0NSpatial.app/VISI0NSpatial') missing.push('unit-test Release TEST_HOST is invalid');
}
for (const [id, obj] of Object.entries(objects)) {
  if (obj.isa === 'PBXBuildFile' && !objects[obj.fileRef]) missing.push(`bad build file ${id}`);
  if (['PBXSourcesBuildPhase','PBXResourcesBuildPhase','PBXFrameworksBuildPhase'].includes(obj.isa)) for (const file of obj.files || []) if (!objects[file]) missing.push(`bad phase ref ${file}`);
}
for (const file of ['Resources/Assets.xcassets/Contents.json','Resources/Assets.xcassets/AppIcon.appiconset/Contents.json']) JSON.parse(fs.readFileSync(file, 'utf8'));
const privacyText = fs.readFileSync('Config/PrivacyInfo.xcprivacy', 'utf8');
const privacyTypes = new Set();
if (privacyText.trimStart().startsWith('{')) {
  const privacy = JSON.parse(privacyText);
  for (const item of privacy.NSPrivacyAccessedAPITypes || []) privacyTypes.add(item.NSPrivacyAccessedAPIType);
} else {
  if (!privacyText.includes('<plist') && !privacyText.includes('<dict')) throw Error('invalid privacy manifest');
  for (const match of privacyText.matchAll(/<key>NSPrivacyAccessedAPIType<\/key>\s*<string>([^<]+)<\/string>/g)) {
    privacyTypes.add(match[1]);
  }
}
for (const type of ['NSPrivacyAccessedAPICategoryUserDefaults','NSPrivacyAccessedAPICategoryFileTimestamp']) if (!privacyTypes.has(type)) missing.push(`privacy manifest missing ${type}`);
for (const file of ['App/Info.plist','Config/PrivacyInfo.xcprivacy','VISI0NSpatial.xcodeproj/project.xcworkspace/xcshareddata/xcschemes/VISI0NSpatial.xcscheme']) {
  const xml = fs.readFileSync(file, 'utf8');
  if (!xml.includes('<plist') && !xml.includes('<Scheme') && !xml.trimStart().startsWith('{')) throw Error(`invalid XML header: ${file}`);
}
const shader = fs.readFileSync('VR/StereoscopicRenderer/SpatialShaders.metal', 'utf8');
if (!shader.includes('uint vertexID [[vertex_id]]') || !shader.includes('vertices[vertexID].position')) throw Error('window vertex shader must index its vertex buffer');
if (!shader.includes('leftEye.sample') || !shader.includes('rightEye.sample')) throw Error('stereo compositor must sample both eye textures');
if (!shader.includes('discard_fragment();') || /\bdiscard\s*;/.test(shader)) throw Error('fragment shader must use discard_fragment()');
if (missing.length) { console.error(missing.join('\n')); process.exit(1); }
console.log(`Validated ${Object.keys(objects).length} project objects; ${included.size} explicit/synchronized files; target source membership, Release tests, privacy declarations, and stereo shader entry points.`);
