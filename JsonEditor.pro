QT += core gui widgets network websockets

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

# Custom run/test targets
run.commands = ./run_with_server.sh
run.depends = $(TARGET)
test.commands = ./run_with_server.sh
test.depends = $(TARGET)
QMAKE_EXTRA_TARGETS += run test

# Double test target (Server + 2 Clients)
double_test.commands = ./double_test.sh
double_test.depends = $(TARGET)
QMAKE_EXTRA_TARGETS += double_test
