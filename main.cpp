#include <QApplication>
#include <QCommandLineParser>
#include <QCommandLineOption>
#include <QSocketNotifier>
#include <signal.h>
#include <sys/socket.h>
#include <unistd.h>
#include "JsonEditorDialog.h"

static int sig_pipe[2];

void signalHandler(int sig)
{
    char a = 1;
    ::write(sig_pipe[0], &a, 1);
}

int main(int argc, char *argv[])
{
    QApplication app(argc, argv);
    QCoreApplication::setApplicationName("JsonEditor");
    QCoreApplication::setApplicationVersion("1.0");

    // Signal handling setup
    if (::socketpair(AF_UNIX, SOCK_STREAM, 0, sig_pipe))
        qFatal("Couldn't create signal pipe");

    QSocketNotifier sn(sig_pipe[1], QSocketNotifier::Read);
    
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
    QCommandLineOption serverOption("server", "Metax Server URL", "url", "https://192.168.11.73:5001");
    parser.addOption(serverOption);
    QCommandLineOption uuidOption("uuid", "Initial UUID to load", "uuid");
    parser.addOption(uuidOption);
    
    parser.process(app);

    JsonEditorDialog dialog;
    
    // Connect the signal notifier to the dialog's forceDisconnect
    QObject::connect(&sn, &QSocketNotifier::activated, [&dialog]() {
        char a;
        ::read(sig_pipe[1], &a, 1);
        dialog.forceDisconnect();
    });

    // Register UNIX signal handler
    ::signal(SIGUSR1, signalHandler);

    if (parser.isSet(serverOption)) {
        dialog.setServerUrl(parser.value(serverOption));
    }
    
    if (parser.isSet(uuidOption)) {
        dialog.loadUuid(parser.value(uuidOption));
    }
    
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
