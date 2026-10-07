package http

import (
	"github.com/mpolden/echoip/iputil/geo"
	"net"
)

func databaseGeneration(r geo.Reader) uint64 {
	if reader, ok := r.(interface{ Generation() uint64 }); ok {
		return reader.Generation()
	}
	return 0
}

func lookupGeo(r geo.Reader, ip net.IP) (geo.Country, geo.City, geo.ASN, uint64) {
	if reader, ok := r.(interface {
		LookupWithGeneration(net.IP) (geo.Country, geo.City, geo.ASN, uint64)
	}); ok {
		return reader.LookupWithGeneration(ip)
	}
	country, _ := r.Country(ip)
	city, _ := r.City(ip)
	asn, _ := r.ASN(ip)
	return country, city, asn, 0
}
