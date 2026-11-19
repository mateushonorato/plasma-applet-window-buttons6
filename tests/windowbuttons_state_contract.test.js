#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const mainQml = fs.readFileSync(path.join(repoRoot, 'package/contents/ui/main.qml'), 'utf8');
const tasksQml = fs.readFileSync(path.join(repoRoot, 'package/contents/ui/PlasmaTasksModel.qml'), 'utf8');
const configXml = fs.readFileSync(path.join(repoRoot, 'package/contents/config/main.xml'), 'utf8');
const configBehaviorQml = fs.readFileSync(path.join(repoRoot, 'package/contents/ui/config/ConfigBehavior.qml'), 'utf8');

assert.match(
  configXml,
  /<entry name="ignoredWindowClasses" type="String">/,
  'config XML must define ignoredWindowClasses'
);

assert.match(
  configBehaviorQml,
  /property alias cfg_ignoredWindowClasses:\s*ignoredWindowClassesTxt\.text/,
  'ConfigBehavior.qml must bind cfg_ignoredWindowClasses to the text field'
);

assert.match(
  tasksQml,
  /function isAppIgnored\(appId, appName\)/,
  'PlasmaTasksModel.qml must have isAppIgnored'
);

assert.match(
  tasksQml,
  /function topmostMaximizedTaskItem\(\)/,
  'PlasmaTasksModel.qml must have topmostMaximizedTaskItem for occlusion detection'
);

function boolProperty(source, name) {
  const match = source.match(new RegExp(`readonly property bool ${name}:\\s*([^\\n]+)`));
  assert.ok(match, `missing readonly property bool ${name}`);
  return match[1].trim();
}

// --- PlasmaTasksModel.qml contract ---

const focusExpr = boolProperty(tasksQml, 'focusOutsideTaskModel');
assert.match(
  focusExpr,
  /!targetTaskItem/,
  'cross-screen focus must not count as outside/unusable while this screen still has a local action target'
);

assert.match(
  tasksQml,
  /readonly property bool hasNoBorder:\s*HasNoBorder === true/,
  'task delegates must expose Plasma 6.4 HasNoBorder as hasNoBorder'
);
assert.match(
  tasksQml,
  /onHasNoBorderChanged:\s*plasmaTasksItem\.updateWindowState\(\)/,
  'titlebar toggles must immediately recompute the represented target'
);
assert.match(
  tasksQml,
  /function borderlessTaskItem\(maximizedOnly\)/,
  'target selection must have a borderless-window selector'
);
assert.match(
  tasksQml,
  /activeTaskItem\.hasNoBorder[\s\S]*borderlessTaskItem\(true\)[\s\S]*if \(lastBorderlessTaskItem\)/,
  'target priority must be active borderless, then maximized borderless, then best shown borderless'
);

// --- main.qml contract ---

const blocksExpr = boolProperty(mainQml, 'blocksInactiveWindowActions');
assert.doesNotMatch(
  blocksExpr,
  /existsMaximizedWindow/,
  'blocking must be based on local target availability, not a broad maximized-window shortcut'
);

const dimsExpr = boolProperty(mainQml, 'dimsInactiveWindowActions');
assert.doesNotMatch(
  dimsExpr,
  /activeFloatingWithoutMaximizedTarget/,
  'a same-screen active floating target should not self-dim; dim only when another local active window obscures the tracked target'
);

assert.match(
  mainQml,
  /readonly property bool isLastActiveWindowBorderless:/,
  'main.qml must expose the represented target titlebar state'
);
assert.match(
  mainQml,
  /if \(!lastActiveTaskItem \|\| !existsWindowShown \|\| !isLastActiveWindowBorderless\)\s*return true;/,
  'all non-AlwaysVisible modes must hide unless the represented target is borderless'
);

// isActive expressions must guard the inactive-gray path with perScreenLocalContext
const isActiveMatches = mainQml.match(/isActive:\s*\{[^}]*perScreenLocalContext[^}]*\}/g);
assert.ok(isActiveMatches && isActiveMatches.length >= 2,
  'both button delegates (pluginButton + auroraeButton) must guard isActive with perScreenLocalContext');
assert.match(
  mainQml,
  /var perScreenLocalContext = root\.perScreenActive && root\.existsWindowShown/,
  'perScreenLocalContext must be perScreenActive && existsWindowShown'
);

// --- State model ---

function desiredState({ inactiveStateEnabled, perScreenActive, hasTrackedWindow, hasActiveTask, hasTargetTaskItem, existsWindowShown, targetObscuredByTrackedWindow }) {
  const focusOutsideTaskModel = hasTrackedWindow && !hasActiveTask && !hasTargetTaskItem;
  const blocksInactiveWindowActions = inactiveStateEnabled && focusOutsideTaskModel;
  const dimsInactiveWindowActions = inactiveStateEnabled && targetObscuredByTrackedWindow;
  const perScreenLocalContext = perScreenActive && existsWindowShown;
  const isLastActiveWindowActive = hasActiveTask;
  const buttonIsGray = blocksInactiveWindowActions ||
    (!perScreenLocalContext && inactiveStateEnabled && existsWindowShown && !isLastActiveWindowActive && !dimsInactiveWindowActions);
  return {
    focusOutsideTaskModel,
    blocksInactiveWindowActions,
    dimsInactiveWindowActions,
    buttonIsGray,
  };
}

function bestTask(tasks, predicate) {
  return tasks.filter(task => !task.isMinimized && predicate(task)).sort((a, b) =>
    b.lastActivated - a.lastActivated || b.stackingOrder - a.stackingOrder)[0] || null;
}

function desiredTarget(tasks) {
  const active = tasks.find(task => task.isActive) || null;
  const shown = bestTask(tasks, () => true);
  const maximized = bestTask(tasks, task => task.isMaximized);
  const borderlessMaximized = bestTask(tasks, task => task.hasNoBorder && task.isMaximized);
  const borderless = bestTask(tasks, task => task.hasNoBorder);

  if (active && active.hasNoBorder && !active.isMinimized)
    return active;
  if (borderlessMaximized)
    return borderlessMaximized;
  if (borderless)
    return borderless;
  if (active && active.isMaximized && !active.isMinimized)
    return active;
  return maximized || active || shown;
}

function desiredMustHide({ alwaysVisible, editMode, target }) {
  if (alwaysVisible || editMode)
    return false;
  return !target || !target.hasNoBorder;
}

const titledFloating = { id: 'titled-floating', hasNoBorder: false, isMaximized: false, isMinimized: false, isActive: true, lastActivated: 40, stackingOrder: 40 };
const borderlessFloating = { id: 'borderless-floating', hasNoBorder: true, isMaximized: false, isMinimized: false, isActive: true, lastActivated: 50, stackingOrder: 50 };
const borderlessTiled = { id: 'borderless-tiled', hasNoBorder: true, isMaximized: false, isMinimized: false, isActive: true, lastActivated: 60, stackingOrder: 60 };
const borderlessMaximized = { id: 'borderless-maximized', hasNoBorder: true, isMaximized: true, isMinimized: false, isActive: false, lastActivated: 30, stackingOrder: 30 };
const titledMaximized = { id: 'titled-maximized', hasNoBorder: false, isMaximized: true, isMinimized: false, isActive: true, lastActivated: 70, stackingOrder: 70 };

assert.equal(desiredMustHide({ alwaysVisible: false, editMode: false, target: desiredTarget([borderlessFloating]) }), false,
  'borderless floating target shows panel buttons');
assert.equal(desiredMustHide({ alwaysVisible: false, editMode: false, target: desiredTarget([borderlessTiled]) }), false,
  'borderless tiled target shows panel buttons');
assert.equal(desiredMustHide({ alwaysVisible: false, editMode: false, target: desiredTarget([borderlessMaximized]) }), false,
  'borderless maximized target shows panel buttons');
assert.equal(desiredMustHide({ alwaysVisible: false, editMode: false, target: desiredTarget([titledMaximized]) }), true,
  'enabling the native titlebar on a maximized target hides panel buttons');
assert.equal(desiredMustHide({ alwaysVisible: false, editMode: false, target: desiredTarget([titledFloating]) }), true,
  'a titled floating target does not duplicate controls in the panel');
assert.equal(desiredTarget([borderlessMaximized, titledFloating]).id, 'borderless-maximized',
  'borderless maximized target stays represented behind an active titled floating window');
assert.equal(desiredTarget([titledMaximized, { ...borderlessFloating, isActive: false }]).id, 'borderless-floating',
  'a shown borderless floating window outranks a titled maximized target');
assert.equal(desiredMustHide({ alwaysVisible: true, editMode: false, target: titledMaximized }), false,
  'AlwaysVisible explicitly overrides titlebar-aware hiding');
assert.equal(desiredMustHide({ alwaysVisible: false, editMode: true, target: titledMaximized }), false,
  'edit mode explicitly overrides titlebar-aware hiding');

const titlebarToggleTarget = { ...borderlessMaximized };
assert.equal(desiredMustHide({ alwaysVisible: false, editMode: false, target: titlebarToggleTarget }), false,
  'maximized target starts visible while borderless');
titlebarToggleTarget.hasNoBorder = false;
assert.equal(desiredMustHide({ alwaysVisible: false, editMode: false, target: titlebarToggleTarget }), true,
  'enabling the native titlebar immediately flips the same target to hidden');
titlebarToggleTarget.hasNoBorder = true;
assert.equal(desiredMustHide({ alwaysVisible: false, editMode: false, target: titlebarToggleTarget }), false,
  'disabling the native titlebar immediately flips the same target back to visible');

// Per-screen: maximized local target stays bright when focus moves to another screen
assert.deepEqual(desiredState({
  inactiveStateEnabled: true,
  perScreenActive: true,
  hasTrackedWindow: true,
  hasActiveTask: false,
  hasTargetTaskItem: true,
  existsWindowShown: true,
  targetObscuredByTrackedWindow: false,
}), {
  focusOutsideTaskModel: false,
  blocksInactiveWindowActions: false,
  dimsInactiveWindowActions: false,
  buttonIsGray: false,
}, 'per-screen: local target stays bright under cross-screen focus');

// Same-screen: floating-over-target dims without blocking
assert.deepEqual(desiredState({
  inactiveStateEnabled: true,
  perScreenActive: true,
  hasTrackedWindow: true,
  hasActiveTask: true,
  hasTargetTaskItem: true,
  existsWindowShown: true,
  targetObscuredByTrackedWindow: true,
}), {
  focusOutsideTaskModel: false,
  blocksInactiveWindowActions: false,
  dimsInactiveWindowActions: true,
  buttonIsGray: false,
}, 'same-screen floating-over-target dims without blocking');

// No local target: remains blocked/gray
assert.deepEqual(desiredState({
  inactiveStateEnabled: true,
  perScreenActive: true,
  hasTrackedWindow: true,
  hasActiveTask: false,
  hasTargetTaskItem: false,
  existsWindowShown: false,
  targetObscuredByTrackedWindow: false,
}), {
  focusOutsideTaskModel: true,
  blocksInactiveWindowActions: true,
  dimsInactiveWindowActions: false,
  buttonIsGray: true,
}, 'no local target remains blocked');

// perScreenActive off: standard inactive gray behavior preserved
assert.deepEqual(desiredState({
  inactiveStateEnabled: true,
  perScreenActive: false,
  hasTrackedWindow: true,
  hasActiveTask: false,
  hasTargetTaskItem: true,
  existsWindowShown: true,
  targetObscuredByTrackedWindow: false,
}), {
  focusOutsideTaskModel: false,
  blocksInactiveWindowActions: false,
  dimsInactiveWindowActions: false,
  buttonIsGray: true,
}, 'perScreenActive off: standard inactive gray behavior preserved');

// --- Ignored Windows Contract & Summary Table Verification ---

function parseIgnoredClasses(raw) {
  const lines = (raw || '').split(/\r?\n/);
  const list = [];
  for (let i = 0; i < lines.length; ++i) {
    const trimmed = lines[i].trim();
    if (trimmed.length > 0)
      list.push(trimmed);
  }
  return list;
}

function isIgnoredApp(ignoredList, appId, appName) {
  if (!ignoredList || ignoredList.length === 0)
    return false;
  const id = (appId || '');
  const name = (appName || '');
  const idLower = id.toLowerCase();
  const nameLower = name.toLowerCase();

  for (let i = 0; i < ignoredList.length; ++i) {
    const pattern = ignoredList[i];
    if (pattern === '$blank') {
      if (id === '' && name === '')
        return true;
      continue;
    }
    if (pattern.length >= 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
      try {
        const regex = new RegExp(pattern.slice(1, -1), 'i');
        if (regex.test(id) || regex.test(name))
          return true;
      } catch (e) {}
      continue;
    }
    const patLower = pattern.toLowerCase();
    if (idLower === patLower || nameLower === patLower)
      return true;
    if (idLower === patLower + '.desktop' || (patLower.endsWith('.desktop') && idLower === patLower.slice(0, -8)))
      return true;
  }
  return false;
}

const multiLineList = parseIgnoredClasses('org.kde.konsole\ngoogle-chrome\r\nzen\n/^org\\.kde\\..*/\n$blank');
assert.deepEqual(multiLineList, ['org.kde.konsole', 'google-chrome', 'zen', '/^org\\.kde\\..*/', '$blank'], 'correctly parses lines');
assert.equal(isIgnoredApp(multiLineList, 'org.kde.konsole', 'Konsole'), true, 'matches exact appId');
assert.equal(isIgnoredApp(multiLineList, 'org.kde.konsole.desktop', 'Konsole'), true, 'matches appId with .desktop');
assert.equal(isIgnoredApp(multiLineList, 'google-chrome', 'Google Chrome'), true, 'matches trimmed token');
assert.equal(isIgnoredApp(multiLineList, 'zen', 'Zen Browser'), true, 'matches zen token');
assert.equal(isIgnoredApp(multiLineList, 'org.kde.dolphin', 'Dolphin'), true, 'matches regex pattern /^org\\.kde\\..*/');
assert.equal(isIgnoredApp(multiLineList, 'alacritty', 'Alacritty'), false, 'does not match unlisted app');
assert.equal(isIgnoredApp(multiLineList, '', ''), true, 'matches $blank for empty window class');

// Semicolons are no longer delimiters:
const semicolonRaw = parseIgnoredClasses('konsole;google-chrome');
assert.equal(semicolonRaw.length, 1, 'semicolons are not split into multiple entries');

function simulateWindowState(tasks, visibility, alwaysVisible = false) {
  const topMax = bestTask(tasks, task => task.isMaximized);
  let target = null;
  if (!topMax || !topMax.isIgnored) {
    const active = tasks.find(task => task.isActive && !task.isIgnored) || null;
    const borderlessMaximized = bestTask(tasks, task => task.hasNoBorder && task.isMaximized && !task.isIgnored);
    const borderless = bestTask(tasks, task => task.hasNoBorder && !task.isIgnored);
    const maximized = bestTask(tasks, task => task.isMaximized && !task.isIgnored);
    const shown = bestTask(tasks, task => !task.isIgnored);

    if (active && active.hasNoBorder && !active.isMinimized)
      target = active;
    else if (borderlessMaximized)
      target = borderlessMaximized;
    else if (borderless)
      target = borderless;
    else if (active && active.isMaximized && !active.isMinimized)
      target = active;
    else
      target = maximized || active || shown;
  }

  const rawActive = tasks.find(task => task.isActive) || null;
  const activeTask = tasks.find(task => task.isActive && !task.isIgnored) || null;
  const existsWindowActive = !!activeTask;
  const existsWindowShown = !!bestTask(tasks, task => !task.isIgnored);
  const isBorderless = target ? target.hasNoBorder : false;

  let mustHide = false;
  if (alwaysVisible) {
    mustHide = false;
  } else if (visibility === 'ActiveWindow' && !existsWindowActive) {
    mustHide = true;
  } else if (!target || !existsWindowShown || !isBorderless) {
    mustHide = true;
  }

  const isButtonsDisabled = !target;
  const targetObscured = target && existsWindowShown && target !== rawActive && !!rawActive;

  return { target, mustHide, isButtonsDisabled, targetObscured };
}

// 1. Ignored Window is Floating (Konsole), Non-ignored Window (Dolphin) is Maximized behind
const dolphinMaximized = { id: 'dolphin', appId: 'org.kde.dolphin', isMaximized: true, isMinimized: false, hasNoBorder: true, isActive: false, lastActivated: 10, stackingOrder: 10, isIgnored: false };
const konsoleFloating = { id: 'konsole', appId: 'org.kde.konsole', isMaximized: false, isMinimized: false, hasNoBorder: true, isActive: true, lastActivated: 20, stackingOrder: 20, isIgnored: true };

// Scenario: Floating Ignored + Maximized non-ignored
assert.equal(simulateWindowState([dolphinMaximized, konsoleFloating], 'MaximizedWindowExists').mustHide, false,
  'Maximized window is shown: shows (targets Dolphin)');
assert.equal(simulateWindowState([dolphinMaximized, konsoleFloating], 'MaximizedWindowExists').target.id, 'dolphin');
assert.equal(simulateWindowState([dolphinMaximized, konsoleFloating], 'MaximizedWindowExists').targetObscured, true,
  'Maximized window is shown: Dolphin buttons dimmed because floating helper is active');
assert.equal(simulateWindowState([dolphinMaximized, konsoleFloating], 'ActiveWindow').mustHide, true,
  'Active window is present: hides (active window is ignored)');
assert.equal(simulateWindowState([dolphinMaximized, konsoleFloating], 'ShownWindowExists').mustHide, false,
  'At least one window is shown: shows (targets Dolphin)');
assert.equal(simulateWindowState([dolphinMaximized, konsoleFloating], 'AlwaysVisible', true).mustHide, false,
  'Always visible: shows (targets Dolphin)');

// 2. Ignored Window is Maximized on top
const konsoleMaximized = { id: 'konsole-max', appId: 'org.kde.konsole', isMaximized: true, isMinimized: false, hasNoBorder: true, isActive: true, lastActivated: 30, stackingOrder: 30, isIgnored: true };

assert.equal(simulateWindowState([dolphinMaximized, konsoleMaximized], 'MaximizedWindowExists').mustHide, true,
  'Maximized window is shown: hides when ignored window is maximized on top');
assert.equal(simulateWindowState([dolphinMaximized, konsoleMaximized], 'ActiveWindow').mustHide, true,
  'Active window is present: hides when ignored window is maximized on top');
assert.equal(simulateWindowState([dolphinMaximized, konsoleMaximized], 'ShownWindowExists').mustHide, true,
  'At least one window is shown: hides when ignored window is maximized on top');
const alwaysVisibleState = simulateWindowState([dolphinMaximized, konsoleMaximized], 'AlwaysVisible', true);
assert.equal(alwaysVisibleState.mustHide, false, 'Always visible: stays visible');
assert.equal(alwaysVisibleState.isButtonsDisabled, true, 'Always visible: buttons disabled when ignored window maximized on top');

// 3. Only Ignored Window is open
assert.equal(simulateWindowState([konsoleFloating], 'MaximizedWindowExists').mustHide, true,
  'Maximized window is shown: hides when only ignored window is open');
assert.equal(simulateWindowState([konsoleFloating], 'ActiveWindow').mustHide, true,
  'Active window is present: hides when only ignored window is open');
assert.equal(simulateWindowState([konsoleFloating], 'ShownWindowExists').mustHide, true,
  'At least one window is shown: hides when only ignored window is open');
assert.equal(simulateWindowState([konsoleFloating], 'AlwaysVisible', true).isButtonsDisabled, true,
  'Always visible: buttons disabled when only ignored window is open');

console.log('windowbuttons state contract ok');
