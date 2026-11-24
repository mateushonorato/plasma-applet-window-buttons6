/*
*  SPDX-FileCopyrightText: 2018 Michail Vourlakos <mvourlakos@gmail.com>
*
*  This file is part of applet-window-buttons
*
*  SPDX-License-Identifier: GPL-2.0-or-later
*/

import QtQml.Models 2.2
import QtQuick 2.7
import org.kde.plasma.core 2.0 as PlasmaCore
import org.kde.plasma.plasmoid 2.0
import org.kde.taskmanager 0.1 as TaskManager

Item {
    id: plasmaTasksItem

    property bool filterByScreen: true
    readonly property var ignoredClassesList: {
        var raw = plasmoid.configuration.ignoredWindowClasses || "";
        var lines = raw.split(/\r?\n/);
        var list = [];
        for (var i = 0; i < lines.length; ++i) {
            var trimmed = lines[i].trim();
            if (trimmed.length > 0)
                list.push(trimmed);

        }
        return list;
    }
    readonly property bool existsWindowActive: activeTaskItem && tasksRepeater.count > 0 && (root.perScreenActive || activeTaskItem.isActive)
    readonly property bool existsWindowShown: shownTaskItem && tasksRepeater.count > 0
    readonly property bool hasTrackedWindow: tasksRepeater.count > 0
    property bool existsMaximizedWindow: false
    readonly property bool targetWindowIsActive: targetTaskItem && existsWindowShown && targetTaskItem.isActive
    readonly property bool hasActiveTask: rawActiveTaskItem && rawActiveTaskItem.isActive
    readonly property bool focusOutsideTaskModel: hasTrackedWindow && (!hasActiveTask || (rawActiveTaskItem && rawActiveTaskItem.isIgnored)) && !targetTaskItem
    readonly property bool targetObscuredByTrackedWindow: targetTaskItem && existsWindowShown && !targetWindowIsActive && hasActiveTask && rawActiveTaskItem !== targetTaskItem
    readonly property bool activeFloatingWithoutMaximizedTarget: targetTaskItem && existsWindowShown && !existsMaximizedWindow && targetWindowIsActive
    readonly property Item lastActiveTaskItem: targetTaskItem
    property Item rawActiveTaskItem: null
    property Item activeTaskItem: null
    property Item lastMaximizedTaskItem: null
    property Item lastBorderlessTaskItem: null
    property Item shownTaskItem: null
    property Item targetTaskItem: null

    function isAppIgnored(appId, appName) {
        if (!ignoredClassesList || ignoredClassesList.length === 0)
            return false;

        var id = (appId || "");
        var name = (appName || "");
        var idLower = id.toLowerCase();
        var nameLower = name.toLowerCase();
        for (var i = 0; i < ignoredClassesList.length; ++i) {
            var pattern = ignoredClassesList[i];
            if (pattern === "$blank") {
                if (id === "" && name === "")
                    return true;

                continue;
            }
            if (pattern.length >= 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
                try {
                    var regexStr = pattern.slice(1, -1);
                    var regex = new RegExp(regexStr, "i");
                    if (regex.test(id) || regex.test(name))
                        return true;

                } catch (e) {
                }
                continue;
            }
            var patLower = pattern.toLowerCase();
            if (idLower === patLower || nameLower === patLower)
                return true;

            if (idLower === patLower + ".desktop" || (patLower.endsWith(".desktop") && idLower === patLower.slice(0, -8)))
                return true;

        }
        return false;
    }

    function isBetterTask(task, currentBest) {
        if (!currentBest)
            return true;

        if (task.isActive && !currentBest.isActive)
            return true;

        if (!task.isActive && currentBest.isActive)
            return false;

        if (task.isKeepAbove && !currentBest.isKeepAbove)
            return true;

        if (!task.isKeepAbove && currentBest.isKeepAbove)
            return false;

        if (task.lastActivated !== currentBest.lastActivated)
            return task.lastActivated > currentBest.lastActivated;

        return task.stackingOrder > currentBest.stackingOrder;
    }

    function bestShownTaskItem() {
        var bestTask = null;
        for (var i = 0; i < tasksRepeater.count; ++i) {
            var task = tasksRepeater.itemAt(i);
            if (!task || task.isMinimized || task.isIgnored)
                continue;

            if (isBetterTask(task, bestTask))
                bestTask = task;

        }
        return bestTask;
    }

    function maximizedTaskItem() {
        var bestTask = null;
        for (var i = 0; i < tasksRepeater.count; ++i) {
            var task = tasksRepeater.itemAt(i);
            if (!task || !task.isMaximized || task.isMinimized || task.isIgnored)
                continue;

            if (isBetterTask(task, bestTask))
                bestTask = task;

        }
        return bestTask;
    }

    function borderlessTaskItem(maximizedOnly) {
        var bestTask = null;
        for (var i = 0; i < tasksRepeater.count; ++i) {
            var task = tasksRepeater.itemAt(i);
            if (!task || !task.hasNoBorder || task.isMinimized || task.isIgnored || (maximizedOnly && !task.isMaximized))
                continue;

            if (isBetterTask(task, bestTask))
                bestTask = task;

        }
        return bestTask;
    }

    function topmostMaximizedTaskItem() {
        var bestTask = null;
        for (var i = 0; i < tasksRepeater.count; ++i) {
            var task = tasksRepeater.itemAt(i);
            if (!task || !task.isMaximized || task.isMinimized)
                continue;

            if (isBetterTask(task, bestTask))
                bestTask = task;

        }
        return bestTask;
    }

    function updateWindowState() {
        for (var i = 0; i < tasksRepeater.count; ++i) {
            var item = tasksRepeater.itemAt(i);
            if (item)
                item.checkPreserveBorder();

        }
        shownTaskItem = bestShownTaskItem();
        lastMaximizedTaskItem = maximizedTaskItem();
        lastBorderlessTaskItem = borderlessTaskItem(false);
        existsMaximizedWindow = lastMaximizedTaskItem !== null;
        var topMax = topmostMaximizedTaskItem();
        if (topMax && topMax.isIgnored) {
            targetTaskItem = null;
            return ;
        }
        if (activeTaskItem && activeTaskItem.hasNoBorder && !activeTaskItem.isMinimized) {
            targetTaskItem = activeTaskItem;
            return ;
        }
        var borderlessMaximizedTaskItem = borderlessTaskItem(true);
        if (borderlessMaximizedTaskItem) {
            targetTaskItem = borderlessMaximizedTaskItem;
            return ;
        }
        if (lastBorderlessTaskItem) {
            targetTaskItem = lastBorderlessTaskItem;
            return ;
        }
        if (activeTaskItem && activeTaskItem.isMaximized && !activeTaskItem.isMinimized) {
            targetTaskItem = activeTaskItem;
            return ;
        }
        targetTaskItem = lastMaximizedTaskItem || activeTaskItem || shownTaskItem;
    }

    function activeTask() {
        for (var i = 0; i < tasksRepeater.count; ++i) {
            var task = tasksRepeater.itemAt(i);
            if (task && task.isActive && !task.isIgnored)
                return task;

        }
        return null;
    }

    function rawActiveTask() {
        for (var i = 0; i < tasksRepeater.count; ++i) {
            var task = tasksRepeater.itemAt(i);
            if (task && task.isActive)
                return task;

        }
        return null;
    }

    function actionTargetTaskItem() {
        updateWindowState();
        return targetTaskItem;
    }

    function toggleMaximized() {
        var task = actionTargetTaskItem();
        if (task)
            task.toggleMaximized();

    }

    function toggleMinimized() {
        var task = actionTargetTaskItem();
        if (task)
            task.toggleMinimized();

    }

    function toggleClose() {
        var task = actionTargetTaskItem();
        if (task)
            task.toggleClose();

    }

    function togglePinToAllDesktops() {
        var task = actionTargetTaskItem();
        if (task)
            task.togglePinToAllDesktops();

    }

    function toggleKeepAbove() {
        var task = actionTargetTaskItem();
        if (task)
            task.toggleKeepAbove();

    }

    onIgnoredClassesListChanged: updateWindowState()

    // To get current activity name
    TaskManager.ActivityInfo {
        id: activityInfo
    }

    // To get virtual desktop name
    TaskManager.VirtualDesktopInfo {
        id: virtualDesktopInfo
    }

    TaskManager.TasksModel {
        id: tasksModel

        sortMode: TaskManager.TasksModel.SortVirtualDesktop
        groupMode: TaskManager.TasksModel.GroupDisabled
        screenGeometry: root.screenGeometry
        activity: activityInfo.currentActivity
        virtualDesktop: virtualDesktopInfo.currentDesktop
        filterByScreen: plasmaTasksItem.filterByScreen
        filterByVirtualDesktop: true
        filterByActivity: true
    }

    Repeater {
        id: tasksRepeater

        model: DelegateModel {
            model: tasksModel

            delegate: Item {
                id: task

                readonly property string title: display
                readonly property string appId: AppId ? AppId : ""
                readonly property string appName: AppName ? AppName : ""
                readonly property bool isIgnored: plasmaTasksItem.isAppIgnored(appId, appName)
                property bool wasDecoratedWhenUnmaximized: false
                readonly property bool isMinimized: IsMinimized === true ? true : false
                readonly property bool isMaximized: IsMaximized === true ? true : false
                readonly property bool isActive: IsActive === true ? true : false
                readonly property bool hasNoBorder: HasNoBorder === true
                readonly property bool isOnAllDesktops: IsOnAllVirtualDesktops === true ? true : false
                readonly property bool isKeepAbove: IsKeepAbove === true ? true : false
                readonly property bool isClosable: IsClosable === true ? true : false
                readonly property bool isMinimizable: IsMinimizable === true ? true : false
                readonly property bool isMaximizable: IsMaximizable === true ? true : false
                readonly property bool isVirtualDesktopsChangeable: IsVirtualDesktopsChangeable === true ? true : false
                readonly property double lastActivated: {
                    var la = LastActivated;
                    if (!la)
                        return 0;

                    if (la instanceof Date)
                        return la.getTime();

                    if (typeof la.getTime === "function")
                        return la.getTime();

                    var n = Number(la);
                    return isNaN(n) ? 0 : n;
                }
                readonly property int stackingOrder: StackingOrder ? StackingOrder : 0

                function checkPreserveBorder() {
                    if (!isIgnored)
                        return ;

                    if (!isMaximized && !hasNoBorder)
                        wasDecoratedWhenUnmaximized = true;

                    if (isMaximized && hasNoBorder && wasDecoratedWhenUnmaximized && CanSetNoBorder)
                        tasksModel.requestToggleNoBorder(modelIndex());

                }

                function modelIndex() {
                    return tasksModel.makeModelIndex(index);
                }

                function toggleMaximized() {
                    tasksModel.requestToggleMaximized(modelIndex());
                }

                function toggleMinimized() {
                    tasksModel.requestToggleMinimized(modelIndex());
                }

                function toggleClose() {
                    tasksModel.requestClose(modelIndex());
                }

                function togglePinToAllDesktops() {
                    tasksModel.requestVirtualDesktops(modelIndex(), isOnAllDesktops ? [virtualDesktopInfo.currentDesktop] : []);
                }

                function toggleKeepAbove() {
                    tasksModel.requestToggleKeepAbove(modelIndex());
                }

                onIsActiveChanged: {
                    plasmaTasksItem.rawActiveTaskItem = isActive ? task : plasmaTasksItem.rawActiveTask();
                    plasmaTasksItem.activeTaskItem = (isActive && !isIgnored) ? task : plasmaTasksItem.activeTask();
                    plasmaTasksItem.updateWindowState();
                }
                onIsIgnoredChanged: {
                    if (isActive)
                        plasmaTasksItem.activeTaskItem = !isIgnored ? task : null;

                    plasmaTasksItem.updateWindowState();
                }
                onIsMinimizedChanged: plasmaTasksItem.updateWindowState()
                onIsMaximizedChanged: plasmaTasksItem.updateWindowState()
                onHasNoBorderChanged: plasmaTasksItem.updateWindowState()
                onLastActivatedChanged: plasmaTasksItem.updateWindowState()
                onStackingOrderChanged: plasmaTasksItem.updateWindowState()
                Component.onCompleted: {
                    checkPreserveBorder();
                    if (isActive) {
                        plasmaTasksItem.rawActiveTaskItem = task;
                        if (!isIgnored)
                            plasmaTasksItem.activeTaskItem = task;

                    }
                    plasmaTasksItem.updateWindowState();
                }
                Component.onDestruction: {
                    if (plasmaTasksItem.rawActiveTaskItem === task)
                        plasmaTasksItem.rawActiveTaskItem = null;

                    if (plasmaTasksItem.activeTaskItem === task)
                        plasmaTasksItem.activeTaskItem = null;

                    if (plasmaTasksItem.lastMaximizedTaskItem === task)
                        plasmaTasksItem.lastMaximizedTaskItem = null;

                    if (plasmaTasksItem.lastBorderlessTaskItem === task)
                        plasmaTasksItem.lastBorderlessTaskItem = null;

                    if (plasmaTasksItem.shownTaskItem === task)
                        plasmaTasksItem.shownTaskItem = null;

                    if (plasmaTasksItem.targetTaskItem === task)
                        plasmaTasksItem.targetTaskItem = null;

                    Qt.callLater(plasmaTasksItem.updateWindowState);
                }
            }

        }

    }

}
