QT += core gui widgets network websockets

CONFIG += c++11

TARGET = JsonEditor
TEMPLATE = app

# Include paths
INCLUDEPATH += include

SOURCES += \
    src/main.cpp \
    src/JsonEditorDialog.cpp

HEADERS += \
    include/JsonEditorDialog.h

# Default rules for deployment
qnx: target.path = /tmp/$${TARGET}/bin
else: unix:!android: target.path = /opt/$${TARGET}/bin
!isEmpty(target.path): INSTALLS += target

# Custom run/test targets
run.commands = ./scripts/JsonEditor.sh
run.depends = $(TARGET)
test.commands = ./scripts/JsonEditor.sh
test.depends = $(TARGET)
QMAKE_EXTRA_TARGETS += run test

# Double test target (Server + 2 Clients)
double_test.commands = ./testing/double_test.sh
double_test.depends = $(TARGET)
QMAKE_EXTRA_TARGETS += double_test
