/*
 * SPDX-FileCopyrightText: 2018 Michail Vourlakos <mvourlakos@gmail.com>
 *
 * This file is part of the libappletdecoration library
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 */

#include "schemesmodel.h"

#include "commontools.h"
#include "schemecolors.h"

#include <QDebug>
#include <QDir>

SchemesModel::SchemesModel(QObject *parent) : QAbstractListModel(parent)
{
    initSchemes();
}

SchemesModel::~SchemesModel()
{
    qDeleteAll(m_schemes);
}

QVariant SchemesModel::data(const QModelIndex &index, int role) const
{
    if (!index.isValid() || index.column() != 0 || index.row() < 0 || index.row() >= (m_schemes.count() + 2))
    {
        return QVariant();
    }

    if (index.row() == 0)
    {
        switch (role)
        {
            case Qt::DisplayRole:
                return QStringLiteral("Current");
            case Qt::UserRole + 4:
                return QStringLiteral("kdeglobals");
            case Qt::UserRole + 5:
                return backgroundOf(0);
            case Qt::UserRole + 6:
                return QVariant();
            default:
                return QVariant();
        }
    }
    else if (index.row() == 1)
    {
        switch (role)
        {
            case Qt::DisplayRole:
                return QStringLiteral("Plasma Theme");
            case Qt::UserRole + 4:
                return QStringLiteral("_plasmatheme_");
            case Qt::UserRole + 5:
                return QColor(Qt::transparent);
            case Qt::UserRole + 6:
                return QVariant();
            default:
                return QVariant();
        }
    }

    const SchemeColors *d = m_schemes[index.row() - 2];

    switch (role)
    {
        case Qt::DisplayRole:
            return d->schemeName();

        case Qt::UserRole + 4:
            return d->schemeFile();

        case Qt::UserRole + 5:
            return d->backgroundColor();

        case Qt::UserRole + 6:
            return d->textColor();
    }

    return QVariant();
}

int SchemesModel::rowCount(const QModelIndex &parent) const
{
    if (parent.isValid())
    {
        return 0;
    }

    return m_schemes.count() + 2;
}

QHash<int, QByteArray> SchemesModel::roleNames() const
{
    QHash<int, QByteArray> roles({ { Qt::DisplayRole, QByteArrayLiteral("display") },
                                   { Qt::UserRole + 4, QByteArrayLiteral("file") },
                                   { Qt::UserRole + 5, QByteArrayLiteral("backgroundColor") },
                                   { Qt::UserRole + 6, QByteArrayLiteral("textColor") } });
    return roles;
}

QColor SchemesModel::backgroundOf(const int &index) const
{
    if (index == 0)
    {
        auto ind = indexOf(m_defaultSchemeFile);
        return (ind >= 2 && (ind - 2) < m_schemes.count()) ? m_schemes[ind - 2]->backgroundColor() : QColor("transparent");
    }

    if (index >= 2 && (index - 2) < m_schemes.count())
    {
        return m_schemes[index - 2]->backgroundColor();
    }

    return QColor("transparent");
}

QString SchemesModel::defaultSchemeFile() const
{
    auto ind = indexOf(m_defaultSchemeFile);

    return (ind >= 2 && (ind - 2) < m_schemes.count()) ? m_schemes[ind - 2]->schemeFile() : QString();
}

void SchemesModel::initSchemes()
{
    qDeleteAll(m_schemes);
    m_schemes.clear();

    QString currentSchemePath = SchemeColors::possibleSchemeFile("kdeglobals");
    insertSchemeInList(currentSchemePath);
    m_defaultSchemeFile = currentSchemePath;

    QStringList standardPaths = standardPathsFor("color-schemes");

    QStringList registeredSchemes;

    for (auto path : standardPaths)
    {
        QDir directory(path);
        QStringList tempSchemes = directory.entryList(QStringList() << "*.colors"
                                                                    << "*.COLORS",
                                                      QDir::Files);

        foreach (QString filename, tempSchemes)
        {
            if (!registeredSchemes.contains(filename))
            {
                QString fullPath = path + "/" + filename;
                insertSchemeInList(fullPath);
                registeredSchemes << filename;
            }
        }
    }
}

void SchemesModel::insertSchemeInList(QString file)
{
    SchemeColors *tempScheme = new SchemeColors(this, file);

    int atPos{ 0 };

    for (int i = 0; i < m_schemes.count(); i++)
    {
        SchemeColors *s = m_schemes[i];

        int result = QString::compare(tempScheme->schemeName(), s->schemeName(), Qt::CaseInsensitive);

        if (result < 0)
        {
            atPos = i;
            break;
        }
        else
        {
            atPos = i + 1;
        }
    }

    m_schemes.insert(atPos, tempScheme);
}

int SchemesModel::indexOf(QString file) const
{
    if (file.isEmpty() || file == "kdeglobals")
    {
        return 0;
    }

    if (file == "_plasmatheme_")
    {
        return 1;
    }

    for (int i = 0; i < m_schemes.count(); i++)
    {
        SchemeColors *s = m_schemes[i];

        if (s->schemeFile() == file)
        {
            return i + 2;
        }
    }

    return -1;
}
