#!/bin/bash

maxmind(){
    cd /var/www/drive/git-releases/maxmind || exit
    
    rm -rf ./*
    
    curl -s https://api.github.com/repos/rabuchaim/geolite2mirror/releases/latest \
    | grep "browser_download_url" \
    | cut -d : -f 2,3 \
    | tr -d \" \
    | wget -qi -
    
    cp ./*.mmdb /home/bea/apps/echoip/geolite2/ 

}


maxmind
