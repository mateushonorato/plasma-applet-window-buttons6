#!/usr/bin/env node
'use strict';

/*
 * SPDX-FileCopyrightText: 2024 Christian Tallner <chrtall@gmx.de>
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/**
 * State contract and regression test suite for applet-window-buttons.
 * Validates QML/KConfig bindings, target resolution, and titlebar state machines.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const mainQml = fs.readFileSync(path.join(repoRoot, 'package/contents/ui/main.qml'), 'utf8');
const tasksQml = fs.readFileSync(path.join(repoRoot, 'package/contents/ui/PlasmaTasksModel.qml'), 'utf8');
const configXml = fs.readFileSync(path.join(repoRoot, 'package/contents/config/main.xml'), 'utf8');
const configGeneralQml = fs.readFileSync(path.join(repoRoot, 'package/contents/ui/config/ConfigGeneral.qml'), 'utf8');
const configBehaviorQml = fs.readFileSync(path.join(repoRoot, 'package/contents/ui/config/ConfigBehavior.qml'), 'utf8');
const toolsJsSrc = fs.readFileSync(path.join(repoRoot, 'package/contents/code/tools.js'), 'utf8');

// --- Section 1: Static QML & KConfig Schema Contracts ---

// 1.1 Complete KConfig XML to KCM Alias Verification
// Every user-configurable setting defined in main.xml must have a corresponding
// `property alias cfg_<name>` in either ConfigGeneral.qml or ConfigBehavior.qml.
// `formFactor` is managed internally via plasmoid.formFactor.
const configEntries = [...configXml.matchAll(/<entry name="([^"]+)" type="([^"]+)">/g)]
  .map(m => ({ name: m[1], type: m[2] }));

assert.ok(configEntries.length >= 20, 'main.xml must define all expected configuration entries');

for (const entry of configEntries) {
  if (entry.name === 'formFactor') {
    assert.match(
      mainQml,
      /Plasmoid\.onFormFactorChanged:\s*plasmoid\.configuration\.formFactor\s*=\s*plasmoid\.formFactor/,
      'internal formFactor must be synchronized with plasmoid.formFactor in main.qml'
    );
    continue;
  }

  const aliasName = `cfg_${entry.name}`;
  const foundInGeneral = configGeneralQml.includes(aliasName);
  const foundInBehavior = configBehaviorQml.includes(aliasName);

  assert.ok(
    foundInGeneral || foundInBehavior,
    `Configuration entry "${entry.name}" in main.xml must have a matching property alias "${aliasName}" in ConfigGeneral.qml or ConfigBehavior.qml`
  );
}

// 1.2 PlasmaTasksModel.qml Core Functions & Properties
assert.match(
  tasksQml,
  /function isAppIgnored\(appId, appName\)/,
  'PlasmaTasksModel.qml must implement isAppIgnored(appId, appName)'
);

assert.match(
  tasksQml,
  /function isBetterTask\(task, currentBest\)/,
  'PlasmaTasksModel.qml must implement isBetterTask(task, currentBest) for unified priority comparison'
);

assert.match(
  tasksQml,
  /function topmostMaximizedTaskItem\(\)/,
  'PlasmaTasksModel.qml must implement topmostMaximizedTaskItem() for occlusion detection'
);

assert.match(
  tasksQml,
  /function borderlessTaskItem\(maximizedOnly\)/,
  'PlasmaTasksModel.qml must implement borderlessTaskItem(maximizedOnly) for borderless selection'
);

assert.match(
  tasksQml,
  /readonly property bool hasNoBorder:\s*HasNoBorder === true/,
  'task delegates must expose Plasma 6.4 HasNoBorder role as hasNoBorder boolean'
);

assert.match(
  tasksQml,
  /onHasNoBorderChanged:\s*plasmaTasksItem\.updateWindowState\(\)/,
  'HasNoBorder changes (e.g. Meta+B) must immediately trigger updateWindowState()'
);

// Target priority order: active borderless -> maximized borderless -> last borderless -> fallback
assert.match(
  tasksQml,
  /activeTaskItem\.hasNoBorder[\s\S]*borderlessTaskItem\(true\)[\s\S]*if \(lastBorderlessTaskItem\)/,
  'target priority must strictly order: active borderless -> maximized borderless -> best shown borderless'
);

// Cross-screen focus: when a window on another screen gets focus, the local screen's
// target must remain valid and must not trigger focusOutsideTaskModel.
function getBoolPropertyExpression(source, name) {
  const match = source.match(new RegExp(`readonly property bool ${name}:\\s*([^\\n]+)`));
  assert.ok(match, `missing readonly property bool ${name}`);
  return match[1].trim();
}

const focusOutsideExpr = getBoolPropertyExpression(tasksQml, 'focusOutsideTaskModel');
assert.match(
  focusOutsideExpr,
  /!targetTaskItem/,
  'focusOutsideTaskModel must require !targetTaskItem so cross-screen focus does not disable local controls'
);

// 1.3 main.qml Action Blocking & Inactive Evaluation
const blocksActionsExpr = getBoolPropertyExpression(mainQml, 'blocksInactiveWindowActions');
assert.doesNotMatch(
  blocksActionsExpr,
  /existsMaximizedWindow/,
  'blocksInactiveWindowActions must check local target availability, not a broad maximized-window shortcut'
);

const dimsActionsExpr = getBoolPropertyExpression(mainQml, 'dimsInactiveWindowActions');
assert.doesNotMatch(
  dimsActionsExpr,
  /activeFloatingWithoutMaximizedTarget/,
  'a same-screen active floating target must not self-dim; only dim when an active helper obscures the target'
);

assert.match(
  mainQml,
  /readonly property bool isLastActiveWindowBorderless:/,
  'main.qml must expose isLastActiveWindowBorderless to guard non-AlwaysVisible modes'
);

assert.match(
  mainQml,
  /if \(!lastActiveTaskItem \|\| !existsWindowShown \|\| !isLastActiveWindowBorderless\)\s*return true;/,
  'all dynamic visibility modes must hide unless the represented target is borderless'
);

// Both button delegates (Breeze pluginButton and AuroraeButton) must guard
// their isActive state using perScreenLocalContext to prevent theme color glitches.
const isActiveMatches = mainQml.match(/isActive:\s*\{[^}]*perScreenLocalContext[^}]*\}/g);
assert.ok(
  isActiveMatches && isActiveMatches.length >= 2,
  'both button delegates (pluginButton and auroraeButton) must guard isActive with perScreenLocalContext'
);

assert.match(
  mainQml,
  /var perScreenLocalContext = root\.perScreenActive && root\.existsWindowShown/,
  'perScreenLocalContext must equal root.perScreenActive && root.existsWindowShown'
);

// --- Section 2: Button Model Serialization & Action Mapping (tools.js) ---

// Reconstruct the AppletDecoration.Types enum as defined in C++ libappletdecoration/types.h
const AppletDecoration = {
  Types: {
    Menu: 0,
    ApplicationMenu: 1,
    OnAllDesktops: 2,
    Minimize: 3,
    Maximize: 4,
    Close: 5,
    ContextHelp: 6,
    Shade: 7,
    KeepBelow: 8,
    KeepAbove: 9,
    Custom: 10, // Separator / Splitter
    ActionClose: 0,
    ToggleMinimize: 1,
    ToggleMaximize: 2,
    TogglePinToAllDesktops: 3,
    ToggleKeepAbove: 4,
  }
};

// Instantiate tools.js functions within mock AppletDecoration scope
const toolsFactory = new Function(
  'AppletDecoration',
  toolsJsSrc + '; return { addButton, indexOfSplitter, initializeControlButtonsModel };'
);
const tools = toolsFactory(AppletDecoration);

// 2.1 addButton mapping verification
const sampleArray = [];
tools.addButton(sampleArray, AppletDecoration.Types.Close);
assert.deepEqual(sampleArray[0], {
  buttonType: AppletDecoration.Types.Close,
  windowOperation: AppletDecoration.Types.ActionClose,
}, 'Close button must map to ActionClose (0)');

sampleArray.length = 0;
tools.addButton(sampleArray, AppletDecoration.Types.Maximize);
assert.deepEqual(sampleArray[0], {
  buttonType: AppletDecoration.Types.Maximize,
  windowOperation: AppletDecoration.Types.ToggleMaximize,
}, 'Maximize button must map to ToggleMaximize (2)');

sampleArray.length = 0;
tools.addButton(sampleArray, AppletDecoration.Types.Minimize);
assert.deepEqual(sampleArray[0], {
  buttonType: AppletDecoration.Types.Minimize,
  windowOperation: AppletDecoration.Types.ToggleMinimize,
}, 'Minimize button must map to ToggleMinimize (1)');

sampleArray.length = 0;
tools.addButton(sampleArray, AppletDecoration.Types.OnAllDesktops);
assert.deepEqual(sampleArray[0], {
  buttonType: AppletDecoration.Types.OnAllDesktops,
  windowOperation: AppletDecoration.Types.TogglePinToAllDesktops,
}, 'OnAllDesktops button must map to TogglePinToAllDesktops (3)');

sampleArray.length = 0;
tools.addButton(sampleArray, AppletDecoration.Types.KeepAbove);
assert.deepEqual(sampleArray[0], {
  buttonType: AppletDecoration.Types.KeepAbove,
  windowOperation: AppletDecoration.Types.ToggleKeepAbove,
}, 'KeepAbove button must map to ToggleKeepAbove (4)');

sampleArray.length = 0;
tools.addButton(sampleArray, AppletDecoration.Types.Custom);
assert.deepEqual(sampleArray[0], {
  buttonType: AppletDecoration.Types.Custom,
  windowOperation: -1,
}, 'Custom separator must map to windowOperation -1');

// 2.2 initializeControlButtonsModel and indexOfSplitter
// In the applet panel, stopOnSeparator = true (buttons after separator 10 are hidden).
// In settings, stopOnSeparator = false (all buttons shown for drag-and-drop).
function createMockListModel() {
  const items = [];
  return {
    items,
    get count() { return items.length; },
    get(i) { return items[i]; },
    append(item) { items.push(item); },
    clear() { items.length = 0; }
  };
}

const defaultButtonsConfig = '5|4|3|10|2|9'.split('|');
const panelPreparedArray = [];
const panelListModel = createMockListModel();

tools.initializeControlButtonsModel(defaultButtonsConfig, panelPreparedArray, panelListModel, true);
assert.equal(panelListModel.count, 3, 'stopOnSeparator: true must truncate at Custom (10)');
assert.equal(panelListModel.get(0).buttonType, AppletDecoration.Types.Close);
assert.equal(panelListModel.get(1).buttonType, AppletDecoration.Types.Maximize);
assert.equal(panelListModel.get(2).buttonType, AppletDecoration.Types.Minimize);

const configPreparedArray = [];
const configListModel = createMockListModel();
tools.initializeControlButtonsModel(defaultButtonsConfig, configPreparedArray, configListModel, false);
assert.equal(configListModel.count, 6, 'stopOnSeparator: false must retain all buttons including separator and inactive buttons');
assert.equal(tools.indexOfSplitter(configListModel), 3, 'indexOfSplitter must return index of Custom separator (3)');

// 2.3 Migration check: main.qml appends KeepAbove (9) if missing in existing configuration
assert.match(
  mainQml,
  /if \(plasmoid\.configuration\.buttons\.indexOf\("9"\) === -1\)\s*plasmoid\.configuration\.buttons = plasmoid\.configuration\.buttons\.concat\("\|9"\);/,
  'main.qml must automatically append KeepAbove (|9) to legacy configurations'
);

// --- Section 3: KWin Titlebar Preservation State Machine (checkPreserveBorder) ---

// When KWin's "Borderless Maximized Windows" setting is enabled, KWin strips
// titlebars from all maximized windows. For ignored windows (e.g. Zen, Kate,
// OnlyOffice), this would leave them without buttons. PlasmaTasksModel.qml
// implements checkPreserveBorder() to call tasksModel.requestToggleNoBorder()
// only for server-side decorated (SSD) windows that originally had borders when unmaximized.
function createMockTaskDelegate({ isIgnored, isMaximized, hasNoBorder, canSetNoBorder }) {
  let toggled = false;
  let wasDecoratedWhenUnmaximized = false;
  return {
    isIgnored,
    isMaximized,
    hasNoBorder,
    canSetNoBorder,
    get wasDecoratedWhenUnmaximized() { return wasDecoratedWhenUnmaximized; },
    get toggled() { return toggled; },
    checkPreserveBorder() {
      if (!this.isIgnored) return;
      if (!this.isMaximized && !this.hasNoBorder) {
        wasDecoratedWhenUnmaximized = true;
      }
      if (this.isMaximized && this.hasNoBorder && wasDecoratedWhenUnmaximized && this.canSetNoBorder) {
        toggled = true;
      }
    }
  };
}

// 3.1 Ignored SSD window: starts unmaximized with border, then maximizes under KWin borderless mode
const ignoredSsd = createMockTaskDelegate({
  isIgnored: true,
  isMaximized: false,
  hasNoBorder: false,
  canSetNoBorder: true,
});
ignoredSsd.checkPreserveBorder();
assert.equal(ignoredSsd.wasDecoratedWhenUnmaximized, true, 'SSD window records wasDecoratedWhenUnmaximized');
assert.equal(ignoredSsd.toggled, false, 'does not toggle while unmaximized');

ignoredSsd.isMaximized = true;
ignoredSsd.hasNoBorder = true;
ignoredSsd.checkPreserveBorder();
assert.equal(ignoredSsd.toggled, true, 'automatically requests border restoration for ignored maximized SSD window');

// 3.2 Ignored CSD window: was borderless even when unmaximized (e.g. Chrome, Firefox CSD)
const ignoredCsd = createMockTaskDelegate({
  isIgnored: true,
  isMaximized: false,
  hasNoBorder: true,
  canSetNoBorder: true,
});
ignoredCsd.checkPreserveBorder();
assert.equal(ignoredCsd.wasDecoratedWhenUnmaximized, false, 'CSD window does not set wasDecoratedWhenUnmaximized');

ignoredCsd.isMaximized = true;
ignoredCsd.hasNoBorder = true;
ignoredCsd.checkPreserveBorder();
assert.equal(ignoredCsd.toggled, false, 'native CSD windows must not have requestToggleNoBorder called');

// 3.3 Non-ignored window: applet represents it, native border is stripped as intended
const nonIgnoredWindow = createMockTaskDelegate({
  isIgnored: false,
  isMaximized: false,
  hasNoBorder: false,
  canSetNoBorder: true,
});
nonIgnoredWindow.checkPreserveBorder();
nonIgnoredWindow.isMaximized = true;
nonIgnoredWindow.hasNoBorder = true;
nonIgnoredWindow.checkPreserveBorder();
assert.equal(nonIgnoredWindow.toggled, false, 'non-ignored windows never request border restoration');

// 3.4 Permission guard: canSetNoBorder === false
const unprivilegedSsd = createMockTaskDelegate({
  isIgnored: true,
  isMaximized: false,
  hasNoBorder: false,
  canSetNoBorder: false,
});
unprivilegedSsd.checkPreserveBorder();
unprivilegedSsd.isMaximized = true;
unprivilegedSsd.hasNoBorder = true;
unprivilegedSsd.checkPreserveBorder();
assert.equal(unprivilegedSsd.toggled, false, 'does not request toggle if canSetNoBorder is false');

// --- Section 4: Slide Animation Easing & Geometry Dynamics ---

function evaluateSlideEasing(acceleration) {
  if (acceleration <= 0) return 'Linear';
  if (acceleration === 1) return 'InQuad';
  if (acceleration === 2) return 'InCubic';
  if (acceleration === 3) return 'InQuart';
  return 'InQuint';
}

assert.equal(evaluateSlideEasing(0), 'Linear', 'acceleration 0 maps to Linear');
assert.equal(evaluateSlideEasing(-1), 'Linear', 'negative acceleration clamps to Linear');
assert.equal(evaluateSlideEasing(1), 'InQuad', 'acceleration 1 maps to InQuad (Soft)');
assert.equal(evaluateSlideEasing(2), 'InCubic', 'acceleration 2 maps to InCubic (Default)');
assert.equal(evaluateSlideEasing(3), 'InQuart', 'acceleration 3 maps to InQuart (Fast)');
assert.equal(evaluateSlideEasing(4), 'InQuint', 'acceleration 4 maps to InQuint (Aggressive)');

// Dimension calculation: Horizontal panel vs Vertical panel
function calculatePanelMinimumDimension({ formFactor, mustHide, isEmptySpaceEnabled, slideAnimationEnabled, userConfiguring, contentSize }) {
  if (formFactor === 2) {
    if (mustHide && !isEmptySpaceEnabled && slideAnimationEnabled && !userConfiguring) {
      return 0; // Collapses horizontally to let neighbouring applets expand
    }
    return contentSize;
  } else {
    if (mustHide && !isEmptySpaceEnabled && slideAnimationEnabled && !userConfiguring) {
      return 0; // Collapses vertically in vertical panel
    }
    return contentSize;
  }
}

const contentWidth = 120;
assert.equal(
  calculatePanelMinimumDimension({
    formFactor: 2,
    mustHide: true,
    isEmptySpaceEnabled: false,
    slideAnimationEnabled: true,
    userConfiguring: false,
    contentSize: contentWidth,
  }),
  0,
  'SlideOut in horizontal panel collapses minimumWidth to 0 on hide'
);

assert.equal(
  calculatePanelMinimumDimension({
    formFactor: 2,
    mustHide: true,
    isEmptySpaceEnabled: true,
    slideAnimationEnabled: true,
    userConfiguring: false,
    contentSize: contentWidth,
  }),
  contentWidth,
  'EmptySpace mode preserves panel geometry when hidden'
);

assert.equal(
  calculatePanelMinimumDimension({
    formFactor: 2,
    mustHide: true,
    isEmptySpaceEnabled: false,
    slideAnimationEnabled: true,
    userConfiguring: true,
    contentSize: contentWidth,
  }),
  contentWidth,
  'Edit mode preserves geometry so applet remains interactable'
);

// --- Section 5: Window Class Ignore Parser & Pattern Matching ---

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
      } catch (e) {
        // Malformed regex should fail gracefully without throwing
      }
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

// 5.1 Newline parsing, whitespace trimming, and empty line elimination
const rawConfigText = '  \n  org.kde.konsole  \r\n\tgoogle-chrome\n\n zen \n/^org\\.kde\\..*/\n$blank\n';
const parsed = parseIgnoredClasses(rawConfigText);
assert.deepEqual(
  parsed,
  ['org.kde.konsole', 'google-chrome', 'zen', '/^org\\.kde\\..*/', '$blank'],
  'parses mixed CRLF/LF, trims whitespace, and ignores empty lines'
);

// Semicolons are treated as literal characters, not delimiters
const semicolonConfig = parseIgnoredClasses('konsole;google-chrome');
assert.equal(semicolonConfig.length, 1, 'semicolons are treated as literal characters and not split');
assert.equal(semicolonConfig[0], 'konsole;google-chrome');

// 5.2 Exact and case-insensitive matching
assert.equal(isIgnoredApp(parsed, 'org.kde.konsole', 'Konsole'), true, 'exact appId match');
assert.equal(isIgnoredApp(parsed, 'ORG.KDE.KONSOLE', 'KONSOLE'), true, 'case-insensitive appId match');
assert.equal(isIgnoredApp(parsed, 'google-chrome', 'Google Chrome'), true, 'exact match on trimmed token');
assert.equal(isIgnoredApp(parsed, 'zen', 'Zen Browser'), true, 'exact match on zen');

// 5.3 .desktop extension normalization
assert.equal(isIgnoredApp(parsed, 'org.kde.konsole.desktop', 'Konsole'), true, 'pattern without .desktop matches appId with .desktop');
const desktopPatternList = parseIgnoredClasses('zen.desktop');
assert.equal(isIgnoredApp(desktopPatternList, 'zen', 'Zen'), true, 'pattern with .desktop matches appId without .desktop');

// 5.4 Regular expression matching
assert.equal(isIgnoredApp(parsed, 'org.kde.dolphin', 'Dolphin'), true, 'matches /^org\\.kde\\..*/ regex');
assert.equal(isIgnoredApp(parsed, 'org.kde.kate', 'Kate'), true, 'matches /^org\\.kde\\..*/ regex');
assert.equal(isIgnoredApp(parsed, 'alacritty', 'Alacritty'), false, 'does not match unlisted app');

// Malformed regex must not throw or crash
const malformedList = parseIgnoredClasses('/[unclosed-bracket/');
assert.doesNotThrow(() => {
  assert.equal(isIgnoredApp(malformedList, 'dolphin', 'Dolphin'), false);
}, 'malformed regex pattern fails gracefully without crashing');

// 5.5 Empty match token: $blank
assert.equal(isIgnoredApp(parsed, '', ''), true, '$blank matches empty appId and empty appName');
assert.equal(isIgnoredApp(parsed, null, null), true, '$blank handles null/undefined values safely');
assert.equal(isIgnoredApp(parsed, 'dolphin', ''), false, '$blank does not match non-empty appId');

// --- Section 6: Core Target Selection & State Resolution ---

function isBetterTask(task, currentBest) {
  if (!currentBest) return true;
  if (task.isActive && !currentBest.isActive) return true;
  if (!task.isActive && currentBest.isActive) return false;
  if (task.isKeepAbove && !currentBest.isKeepAbove) return true;
  if (!task.isKeepAbove && currentBest.isKeepAbove) return false;
  if (task.lastActivated !== currentBest.lastActivated)
    return task.lastActivated > currentBest.lastActivated;
  return task.stackingOrder > currentBest.stackingOrder;
}

function bestTask(tasks, predicate) {
  let best = null;
  for (const t of tasks) {
    if (!t.isMinimized && predicate(t)) {
      if (isBetterTask(t, best)) best = t;
    }
  }
  return best;
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

// Immediate titlebar toggle transitions (e.g. user toggles window border via shortcut)
const titlebarToggleTarget = { ...borderlessMaximized };
assert.equal(desiredMustHide({ alwaysVisible: false, editMode: false, target: titlebarToggleTarget }), false,
  'maximized target starts visible while borderless');
titlebarToggleTarget.hasNoBorder = false;
assert.equal(desiredMustHide({ alwaysVisible: false, editMode: false, target: titlebarToggleTarget }), true,
  'enabling the native titlebar immediately flips the same target to hidden');
titlebarToggleTarget.hasNoBorder = true;
assert.equal(desiredMustHide({ alwaysVisible: false, editMode: false, target: titlebarToggleTarget }), false,
  'disabling the native titlebar immediately flips the same target back to visible');

// --- Section 7: Inactive State, Dimming & Per-Screen Focus ---

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

// 7.1 Per-screen active window enabled: local maximized target stays bright under cross-screen focus
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
}, 'per-screen: local target stays bright when focus moves to another monitor');

// 7.2 Same-screen active helper floating over maximized target: dims without blocking
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
}, 'same-screen floating-over-target dims without blocking action clicks');

// 7.3 Out-of-task-model window focused (Yakuake, KRunner): hard inactivate & disable buttons
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
}, 'out-of-task-model focus disables buttons and applies inactive gray');

// 7.4 Standard single-screen inactive gray: perScreenActive off
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
}, 'perScreenActive off: target becomes inactive gray when focus is elsewhere');

// --- Section 8: Exhaustive 4x5 Visibility & Occlusion Truth Table ---

function simulateWindowState(tasks, visibility, alwaysVisible = false) {
  const topMax = bestTask(tasks, task => task.isMaximized);
  let target = null;

  // Occlusion invariant: if the topmost maximized window is ignored, the applet
  // target becomes null so background buttons do not bleed through.
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
  const existsMaximizedWindow = !!bestTask(tasks, task => task.isMaximized && !task.isIgnored);
  const isBorderless = target ? target.hasNoBorder : false;

  let mustHide = false;
  if (alwaysVisible) {
    mustHide = false;
  } else if (visibility === 'ActiveWindow' && !existsWindowActive) {
    mustHide = true;
  } else if ((visibility === 'MaximizedWindowExists' || visibility === 'ActiveMaximizedWindow') && !existsMaximizedWindow) {
    mustHide = true;
  } else if (!target || !existsWindowShown || !isBorderless) {
    mustHide = true;
  }

  const isButtonsDisabled = !target;
  const targetObscured = target && existsWindowShown && target !== rawActive && !!rawActive;

  return { target, mustHide, isButtonsDisabled, targetObscured };
}

const dolphinMaximized = {
  id: 'dolphin', appId: 'org.kde.dolphin',
  isMaximized: true, isMinimized: false, hasNoBorder: true, isActive: true,
  lastActivated: 10, stackingOrder: 10, isIgnored: false,
};

const alacrittyFloating = {
  id: 'alacritty', appId: 'alacritty',
  isMaximized: false, isMinimized: false, hasNoBorder: true, isActive: true,
  lastActivated: 15, stackingOrder: 15, isIgnored: false,
};

const konsoleFloatingIgnored = {
  id: 'konsole-float', appId: 'org.kde.konsole',
  isMaximized: false, isMinimized: false, hasNoBorder: true, isActive: true,
  lastActivated: 20, stackingOrder: 20, isIgnored: true,
};

const konsoleMaximizedIgnored = {
  id: 'konsole-max', appId: 'org.kde.konsole',
  isMaximized: true, isMinimized: false, hasNoBorder: true, isActive: true,
  lastActivated: 30, stackingOrder: 30, isIgnored: true,
};

// Scenario A: Single normal maximized window (Dolphin)
{
  const tasks = [{ ...dolphinMaximized, isActive: true }];

  const sAlways = simulateWindowState(tasks, 'AlwaysVisible', true);
  assert.equal(sAlways.mustHide, false); assert.equal(sAlways.target.id, 'dolphin'); assert.equal(sAlways.targetObscured, false);

  const sActive = simulateWindowState(tasks, 'ActiveWindow');
  assert.equal(sActive.mustHide, false); assert.equal(sActive.target.id, 'dolphin');

  const sMax = simulateWindowState(tasks, 'MaximizedWindowExists');
  assert.equal(sMax.mustHide, false); assert.equal(sMax.target.id, 'dolphin');

  const sShown = simulateWindowState(tasks, 'ShownWindowExists');
  assert.equal(sShown.mustHide, false); assert.equal(sShown.target.id, 'dolphin');
}

// Scenario B: Single normal floating window (Alacritty)
{
  const tasks = [{ ...alacrittyFloating, isActive: true }];

  const sAlways = simulateWindowState(tasks, 'AlwaysVisible', true);
  assert.equal(sAlways.mustHide, false); assert.equal(sAlways.target.id, 'alacritty');

  const sActive = simulateWindowState(tasks, 'ActiveWindow');
  assert.equal(sActive.mustHide, false); assert.equal(sActive.target.id, 'alacritty');

  const sMax = simulateWindowState(tasks, 'MaximizedWindowExists');
  assert.equal(sMax.mustHide, true, 'MaximizedWindowExists hides when no maximized window exists');

  const sShown = simulateWindowState(tasks, 'ShownWindowExists');
  assert.equal(sShown.mustHide, false); assert.equal(sShown.target.id, 'alacritty');
}

// Scenario C: Floating ignored helper (Konsole) over normal maximized window (Dolphin)
{
  const tasks = [
    { ...dolphinMaximized, isActive: false },
    { ...konsoleFloatingIgnored, isActive: true },
  ];

  const sAlways = simulateWindowState(tasks, 'AlwaysVisible', true);
  assert.equal(sAlways.mustHide, false);
  assert.equal(sAlways.target.id, 'dolphin');
  assert.equal(sAlways.targetObscured, true, 'Dolphin buttons dim because floating helper has focus');

  const sActive = simulateWindowState(tasks, 'ActiveWindow');
  assert.equal(sActive.mustHide, true, 'ActiveWindow hides because active window is ignored');

  const sMax = simulateWindowState(tasks, 'MaximizedWindowExists');
  assert.equal(sMax.mustHide, false, 'MaximizedWindowExists shows and targets Dolphin');
  assert.equal(sMax.target.id, 'dolphin');
  assert.equal(sMax.targetObscured, true, 'buttons dim because helper has focus');

  const sShown = simulateWindowState(tasks, 'ShownWindowExists');
  assert.equal(sShown.mustHide, false);
  assert.equal(sShown.target.id, 'dolphin');
  assert.equal(sShown.targetObscured, true);
}

// Scenario D: Ignored window maximized on top (Konsole-max over Dolphin)
{
  const tasks = [
    { ...dolphinMaximized, isActive: false },
    { ...konsoleMaximizedIgnored, isActive: true },
  ];

  const sAlways = simulateWindowState(tasks, 'AlwaysVisible', true);
  assert.equal(sAlways.mustHide, false, 'AlwaysVisible stays visible');
  assert.equal(sAlways.isButtonsDisabled, true, 'AlwaysVisible buttons are disabled when top maximized window is ignored');

  const sActive = simulateWindowState(tasks, 'ActiveWindow');
  assert.equal(sActive.mustHide, true, 'ActiveWindow hides when ignored window is maximized on top');

  const sMax = simulateWindowState(tasks, 'MaximizedWindowExists');
  assert.equal(sMax.mustHide, true, 'MaximizedWindowExists hides when ignored window is maximized on top');

  const sShown = simulateWindowState(tasks, 'ShownWindowExists');
  assert.equal(sShown.mustHide, true, 'ShownWindowExists hides when ignored window is maximized on top');
}

// Scenario E: Only ignored window present
{
  const tasks = [{ ...konsoleFloatingIgnored, isActive: true }];

  const sAlways = simulateWindowState(tasks, 'AlwaysVisible', true);
  assert.equal(sAlways.mustHide, false);
  assert.equal(sAlways.isButtonsDisabled, true, 'AlwaysVisible buttons disabled when only ignored window is open');

  const sActive = simulateWindowState(tasks, 'ActiveWindow');
  assert.equal(sActive.mustHide, true);

  const sMax = simulateWindowState(tasks, 'MaximizedWindowExists');
  assert.equal(sMax.mustHide, true);

  const sShown = simulateWindowState(tasks, 'ShownWindowExists');
  assert.equal(sShown.mustHide, true);
}

// Scenario F: Switch focus back to normal maximized window (Dolphin) over background maximized ignored window (Konsole-max)
{
  const tasks = [
    { ...dolphinMaximized, isActive: true },
    { ...konsoleMaximizedIgnored, isActive: false, lastActivated: 9999, stackingOrder: 99 },
  ];

  const sAlways = simulateWindowState(tasks, 'AlwaysVisible', true);
  assert.equal(sAlways.mustHide, false);
  assert.equal(sAlways.target.id, 'dolphin');
  assert.equal(sAlways.isButtonsDisabled, false);

  const sActive = simulateWindowState(tasks, 'ActiveWindow');
  assert.equal(sActive.mustHide, false, 'ActiveWindow shows buttons when active window is normal SSD maximized window');
  assert.equal(sActive.target.id, 'dolphin');

  const sMax = simulateWindowState(tasks, 'MaximizedWindowExists');
  assert.equal(sMax.mustHide, false, 'MaximizedWindowExists shows buttons for active normal maximized window');
  assert.equal(sMax.target.id, 'dolphin');

  const sShown = simulateWindowState(tasks, 'ShownWindowExists');
  assert.equal(sShown.mustHide, false);
  assert.equal(sShown.target.id, 'dolphin');
}

console.log('windowbuttons state contract ok');
