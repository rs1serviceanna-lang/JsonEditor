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
#include <QtWebSockets/QWebSocket>
#include <QSet>
#include <QRegularExpression>
#include <QUrl>
#include <QUrlQuery>
#include <QDateTime>

class JsonEditorDialog : public QDialog
{
    Q_OBJECT

public:
    explicit JsonEditorDialog(QWidget *parent = nullptr);
    ~JsonEditorDialog();
    
    void parse(const QString &uuid);
    void show();
    void forceDisconnect();

private slots:
    void onLoadClicked();
    void onSaveClicked();
    void onGetFinished(QNetworkReply *reply);
    void onPostFinished(QNetworkReply *reply);
    void onTextMessageReceived(const QString &message);
    void onSslErrors(const QList<QSslError> &errors);
    void onDisconnected();
    void onError(QAbstractSocket::SocketError error);
    void scheduleReconnect(int delayMs);

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
    QWebSocket *webSocket;
    QString currentUuid;
    QJsonObject currentJson;
    QString wsToken;
    QSet<QString> dependencyUuids;
    
    // WebSocket reconnection tracking
    QDateTime lastConnectionAttempt;
    int reconnectAttempts = 0;
    QTimer *reconnectTimer = nullptr;

    void reconnect();
    void registerListener(const QString &uuid);
    void findUuids(const QJsonValue &val, QSet<QString> &found);
    
    // Constants
    QString baseUrl = "https://192.168.11.73:5001";
    
public:
    void setServerUrl(const QString &url);
    void loadUuid(const QString &uuid);
};

#endif // JSONEDITORDIALOG_H
