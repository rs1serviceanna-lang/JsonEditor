#!/bin/bash

#setting environment variable for self-signed certificate ignorance
#NOTE THIS LINE NEEDS TO BE DELETED IN RELEASE MODE
#export NODE_TLS_REJECT_UNAUTHORIZED=0

source ./start.conf

#start metax
pushd ./metax_2/
npm start storage=../storage/ port=$METAX_PORT key=$SELF_PRIVKEY cert=$SELF_CERT 
popd

sleep 2 # wait metax starting

