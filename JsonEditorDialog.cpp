#include "JsonEditorDialog.h"
#include <QJsonArray>
#include <QJsonObject>
#include <QJsonDocument>
#include <QMessageBox>
#include <QFile>
#include <QSslCertificate>
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QLabel>
#include <QFont>

JsonEditorDialog::JsonEditorDialog(QWidget *parent)
    : QDialog(parent)
    , networkManager(new QNetworkAccessManager(this))
    , webSocket(new QWebSocket(QString(), QWebSocketProtocol::VersionLatest, this))
{
    // Load and trust the server certificate
    QFile certFile("metax.crt");
    if (certFile.open(QIODevice::ReadOnly)) {
        QSslCertificate cert(&certFile);
        QSslConfiguration sslConfig = QSslConfiguration::defaultConfiguration();
        QList<QSslCertificate> caCerts = sslConfig.caCertificates();
        caCerts.append(cert);
        sslConfig.setCaCertificates(caCerts);
        QSslConfiguration::setDefaultConfiguration(sslConfig);
        qDebug() << "Trusted metax.crt for SSL/ALPN";
    }

    setupUi();
    
    connect(webSocket, &QWebSocket::textMessageReceived, this, &JsonEditorDialog::onTextMessageReceived);
    connect(webSocket, QOverload<const QList<QSslError>&>::of(&QWebSocket::sslErrors), this, &JsonEditorDialog::onSslErrors);
    connect(webSocket, &QWebSocket::connected, [this]() {
        qDebug() << "WebSocket connected";
    });
    
    webSocket->open(QUrl("wss://localhost:5001"));
}

JsonEditorDialog::~JsonEditorDialog()
{
}

void JsonEditorDialog::show()
{
    QDialog::show();
}

void JsonEditorDialog::setupUi()
{
    setWindowTitle("JSON Editor - MetaX");
    setMinimumSize(800, 600);
    
    QVBoxLayout *mainLayout = new QVBoxLayout(this);
    
    // UUID Input
    QHBoxLayout *uuidLayout = new QHBoxLayout();
    QLabel *uuidLabel = new QLabel("UUID:", this);
    uuidInput = new QLineEdit(this);
    uuidInput->setPlaceholderText("Enter UUID here...");
    loadButton = new QPushButton("Load", this);
    
    uuidLayout->addWidget(uuidLabel);
    uuidLayout->addWidget(uuidInput);
    uuidLayout->addWidget(loadButton);
    
    mainLayout->addLayout(uuidLayout);
    
    // JSON Editor
    QLabel *jsonLabel = new QLabel("JSON Data:", this);
    mainLayout->addWidget(jsonLabel);
    
    jsonEditor = new QTextEdit(this);
    jsonEditor->setFont(QFont("Courier", 10));
    mainLayout->addWidget(jsonEditor);
    
    // Status Label
    statusLabel = new QLabel("", this);
    statusLabel->setStyleSheet("QLabel { color: blue; padding: 5px; }");
    mainLayout->addWidget(statusLabel);
    
    // Save Button
    saveButton = new QPushButton("Save", this);
    saveButton->setEnabled(false);
    mainLayout->addWidget(saveButton);
    
    // Connections
    connect(loadButton, &QPushButton::clicked, this, &JsonEditorDialog::onLoadClicked);
    connect(saveButton, &QPushButton::clicked, this, &JsonEditorDialog::onSaveClicked);
}

void JsonEditorDialog::parse(const QString &uuid)
{
    if (uuid.isEmpty()) {
        QMessageBox::warning(this, "Error", "Please enter a UUID");
        return;
    }
    
    currentUuid = uuid;
    statusLabel->setText("Loading...");
    statusLabel->setStyleSheet("QLabel { color: blue; padding: 5px; }");
    saveButton->setEnabled(false);
    
    // GET request
    QStringList idParts = uuid.split('#');
    QString reqId = idParts.first();
    QString urlStr = QString("%1/db/get?id=%2").arg(BASE_URL).arg(QString::fromUtf8(QUrl::toPercentEncoding(reqId)));
    QNetworkRequest request((QUrl(urlStr)));
    
    // Ignore SSL errors (verify=False)
    QSslConfiguration sslConfig = request.sslConfiguration();
    sslConfig.setPeerVerifyMode(QSslSocket::VerifyNone);
    request.setSslConfiguration(sslConfig);
    
    // Enable HTTP/2
    request.setAttribute(QNetworkRequest::Http2AllowedAttribute, true);
    
    QNetworkReply *reply = networkManager->get(request);
    connect(reply, &QNetworkReply::finished, [this, reply]() {
        onGetFinished(reply);
    });
}

void JsonEditorDialog::onTextMessageReceived(const QString &message)
{
    QJsonDocument doc = QJsonDocument::fromJson(message.toUtf8());
    if (doc.isNull() || !doc.isObject()) return;
    QJsonObject obj = doc.object();
    
    if (obj.contains("token")) {
        wsToken = obj["token"].toString();
        qDebug() << "Received token:" << wsToken;
        if (!currentUuid.isEmpty()) {
            QStringList parts = currentUuid.split('#');
            for (const QString &p : parts) registerListener(p);
            for (const QString &d : dependencyUuids) registerListener(d);
        }
    } else if (obj.contains("event") && obj["event"].toString() == "update") {
        QString uuid = obj["uuid"].toString();
        QStringList monitored = currentUuid.split('#');
        if (monitored.contains(uuid) || dependencyUuids.contains(uuid)) {
            qDebug() << "Update detected for" << uuid << "- Reloading";
            parse(currentUuid);
        }
    }
}

void JsonEditorDialog::onSslErrors(const QList<QSslError> &errors)
{
    qDebug() << "WS SSL Errors:" << errors;
    webSocket->ignoreSslErrors();
}

void JsonEditorDialog::registerListener(const QString &uuid)
{
    if (wsToken.isEmpty() || uuid.isEmpty()) return;
    QString urlStr = QString("%1/db/register_listener?id=%2&token=%3")
        .arg(BASE_URL).arg(QString::fromUtf8(QUrl::toPercentEncoding(uuid))).arg(wsToken);
    QNetworkRequest request((QUrl(urlStr)));
    QSslConfiguration sslConfig = request.sslConfiguration();
    sslConfig.setPeerVerifyMode(QSslSocket::VerifyNone);
    request.setSslConfiguration(sslConfig);
    request.setAttribute(QNetworkRequest::Http2AllowedAttribute, true);
    
    networkManager->get(request);
}

static const QRegularExpression UUID_RE("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", QRegularExpression::CaseInsensitiveOption);

void JsonEditorDialog::findUuids(const QJsonValue &val, QSet<QString> &found)
{
    if (val.isString()) {
        QString s = val.toString();
        if (UUID_RE.match(s).hasMatch()) found.insert(s);
    } else if (val.isArray()) {
        for (const QJsonValue &v : val.toArray()) findUuids(v, found);
    } else if (val.isObject()) {
        for (const QJsonValue &v : val.toObject()) findUuids(v, found);
    }
}

void JsonEditorDialog::onLoadClicked()
{
    parse(uuidInput->text().trimmed());
}

void JsonEditorDialog::onSaveClicked()
{
    if (currentUuid.isEmpty()) {
        QMessageBox::warning(this, "Error", "UUID is missing");
        return;
    }
    
    QJsonObject jsonToSave = getJsonFromEditor();
    if (jsonToSave.isEmpty() && !jsonEditor->toPlainText().trimmed().isEmpty()) {
        QMessageBox::warning(this, "Error", "Invalid JSON format");
        return;
    }
    
    statusLabel->setText("Saving...");
    statusLabel->setStyleSheet("QLabel { color: blue; padding: 5px; }");
    saveButton->setEnabled(false);
    
    // POST request
    QString urlStr = QString("%1/db/save/node?id=%2").arg(BASE_URL).arg(currentUuid);
    QNetworkRequest request((QUrl(urlStr)));
    
    // Ignore SSL
    QSslConfiguration sslConfig = request.sslConfiguration();
    sslConfig.setPeerVerifyMode(QSslSocket::VerifyNone);
    request.setSslConfiguration(sslConfig);
    
    // HTTP/2
    request.setAttribute(QNetworkRequest::Http2AllowedAttribute, true);
    
    // Headers
    request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    request.setRawHeader("Accept", "application/json");
    
    QJsonDocument doc(jsonToSave);
    QByteArray jsonData = doc.toJson(QJsonDocument::Compact);
    
    QNetworkReply *reply = networkManager->post(request, jsonData);
    connect(reply, &QNetworkReply::finished, [this, reply]() {
        onPostFinished(reply);
    });
}

void JsonEditorDialog::onGetFinished(QNetworkReply *reply)
{
    reply->deleteLater();
    
    if (reply->error() != QNetworkReply::NoError) {
        statusLabel->setText("Error: " + reply->errorString());
        statusLabel->setStyleSheet("QLabel { color: red; padding: 5px; }");
        return;
    }
    
    QByteArray data = reply->readAll();
    QJsonDocument doc = QJsonDocument::fromJson(data);
    
    if (doc.isNull()) {
         statusLabel->setText("Error: Received invalid JSON");
         statusLabel->setStyleSheet("QLabel { color: red; padding: 5px; }");
         return;
    }
    
    if (doc.isObject()) {
        currentJson = doc.object();
        displayJson(currentJson);
        
        statusLabel->setText("✓ Loaded successfully");
        statusLabel->setStyleSheet("QLabel { color: green; padding: 5px; }");
        saveButton->setEnabled(true);
    } else {
         statusLabel->setText("Error: JSON is not an object");
         statusLabel->setStyleSheet("QLabel { color: red; padding: 5px; }");
    }
}

void JsonEditorDialog::onPostFinished(QNetworkReply *reply)
{
    reply->deleteLater();
    
    if (reply->error() != QNetworkReply::NoError) {
        statusLabel->setText("Error: " + reply->errorString());
        statusLabel->setStyleSheet("QLabel { color: red; padding: 5px; }");
        saveButton->setEnabled(true);
        return;
    }
    
    statusLabel->setText("✓ Saved successfully");
    statusLabel->setStyleSheet("QLabel { color: green; padding: 5px; }");
    
    // Reload to verify data
    QTimer::singleShot(500, this, &JsonEditorDialog::onLoadClicked);
}

void JsonEditorDialog::displayJson(const QJsonObject &json)
{
    QJsonDocument doc(json);
    QString jsonString = doc.toJson(QJsonDocument::Indented);
    jsonEditor->setPlainText(jsonString);
}

QJsonObject JsonEditorDialog::getJsonFromEditor()
{
    QString jsonString = jsonEditor->toPlainText();
    QJsonDocument doc = QJsonDocument::fromJson(jsonString.toUtf8());
    
    if (doc.isNull() || !doc.isObject()) {
        return QJsonObject();
    }
    
    return doc.object();
}
