QT += core gui widgets network

CONFIG += c++11

TARGET = JsonEditor
TEMPLATE = app

SOURCES += \
    main.cpp \
    JsonEditorDialog.cpp

HEADERS += \
    JsonEditorDialog.h

# Default rules for deployment
qnx: target.path = /tmp/$${TARGET}/bin
else: unix:!android: target.path = /opt/$${TARGET}/bin
!isEmpty(target.path): INSTALLS += target

# Custom run target
run.commands = ./run_with_server.sh
run.depends = $(TARGET)
QMAKE_EXTRA_TARGETS += run
