#ifndef JSONEDITORDIALOG_H
#define JSONEDITORDIALOG_H

#include <QDialog>
#include <QLineEdit>
#include <QTextEdit>
#include <QPushButton>
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QLabel>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QSslConfiguration>
#include <QMessageBox>
#include <QTimer>

class JsonEditorDialog : public QDialog
{
    Q_OBJECT

public:
    explicit JsonEditorDialog(QWidget *parent = nullptr);
    ~JsonEditorDialog();
    
    void parse(const QString &uuid);
    void show();

private slots:
    void onLoadClicked();
    void onSaveClicked();
    void onGetFinished(QNetworkReply *reply);
    void onPostFinished(QNetworkReply *reply);

private:
    void setupUi();
    void displayJson(const QJsonObject &json);
    QJsonObject getJsonFromEditor();
    
    // UI Elements
    QLineEdit *uuidInput;
    QTextEdit *jsonEditor;
    QPushButton *loadButton;
    QPushButton *saveButton;
    QLabel *statusLabel;
    
    // Networking
    QNetworkAccessManager *networkManager;
    QString currentUuid;
    QJsonObject currentJson;
    
    // Constants
    const QString BASE_URL = "https://localhost:5001";
};

#endif // JSONEDITORDIALOG_H
