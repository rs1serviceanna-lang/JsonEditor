#include <QApplication>
#include "JsonEditorDialog.h"

int main(int argc, char *argv[])
{
    QApplication app(argc, argv);
    
    JsonEditorDialog dialog;
    dialog.show();
    
    return app.exec();
}
