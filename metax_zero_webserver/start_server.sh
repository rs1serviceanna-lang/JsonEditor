#!/bin/bash

#setting environment variable for self-signed certificate ignorance
#NOTE THIS LINE NEEDS TO BE DELETED IN RELEASE MODE
#export NODE_TLS_REJECT_UNAUTHORIZED=0

source ./start.conf

#start metax with localhost certificates for client validation
pushd ./metax_2/
npm start storage=../storage/ port=$METAX_PORT key=$LOCALHOST_METAX_KEY cert=$LOCALHOST_METAX_CERT ca=$LOCALHOST_CA &
popd

sleep 5 # wait metax starting

#start greenhosting webserver with client certificates
pushd ./greenhosting_webserver_2/
npm start host_metax=localhost:$METAX_PORT sitemap_uuid=$SITEMAP_UUID read_server_port=$READ_PORT write_server_port=$WRITE_PORT key=$SELF_PRIVKEY cert=$SELF_CERT client_key=$LOCALHOST_CLIENT_KEY client_cert=$LOCALHOST_CLIENT_CERT ca=$LOCALHOST_CA
popd 
