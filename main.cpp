#include <QApplication>
#include <QCommandLineParser>
#include <QCommandLineOption>
#include "JsonEditorDialog.h"

int main(int argc, char *argv[])
{
    QApplication app(argc, argv);
    QCoreApplication::setApplicationName("JsonEditor");
    QCoreApplication::setApplicationVersion("1.0");

    QCommandLineParser parser;
    parser.setApplicationDescription("JSON Editor");
    parser.addHelpOption();
    parser.addVersionOption();

    QCommandLineOption xOption("x", "Window X position", "x", "0");
    parser.addOption(xOption);
    QCommandLineOption yOption("y", "Window Y position", "y", "0");
    parser.addOption(yOption);
    QCommandLineOption wOption("width", "Window width", "width", "800");
    parser.addOption(wOption);
    QCommandLineOption hOption("height", "Window height", "height", "600");
    parser.addOption(hOption);

    parser.process(app);

    JsonEditorDialog dialog;
    
    int x = parser.value(xOption).toInt();
    int y = parser.value(yOption).toInt();
    int w = parser.value(wOption).toInt();
    int h = parser.value(hOption).toInt();

    if (parser.isSet(xOption) || parser.isSet(yOption)) {
        dialog.move(x, y);
    }
    
    if (parser.isSet(wOption) || parser.isSet(hOption)) {
        dialog.resize(w, h);
    }

    dialog.show();
    
    return app.exec();
}
