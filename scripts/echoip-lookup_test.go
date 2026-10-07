package http

import (
	"github.com/mpolden/echoip/iputil/geo"
	"net"
	"net/http/httptest"
	"testing"
)

type changingReader struct{ generation uint64 }

func (r *changingReader) Country(net.IP) (geo.Country, error) {
	return geo.Country{Name: "current"}, nil
}
func (r *changingReader) City(net.IP) (geo.City, error) { return geo.City{}, nil }
func (r *changingReader) ASN(net.IP) (geo.ASN, error)   { return geo.ASN{}, nil }
func (r *changingReader) IsEmpty() bool                 { return false }
func (r *changingReader) Generation() uint64            { return r.generation }
func (r *changingReader) LookupWithGeneration(ip net.IP) (geo.Country, geo.City, geo.ASN, uint64) {
	c, _ := r.Country(ip)
	return c, geo.City{}, geo.ASN{}, r.generation
}

func TestResponseCacheInvalidatesOnDatabaseReload(t *testing.T) {
	r := &changingReader{generation: 1}
	s := New(r, NewCache(10), false)
	request := httptest.NewRequest("GET", "http://ip.example/json?ip=8.8.8.8", nil)
	first, err := s.newResponse(request)
	if err != nil || first.databaseGeneration != 1 {
		t.Fatal("initial generation missing")
	}
	r.generation = 2
	second, err := s.newResponse(request)
	if err != nil || second.databaseGeneration != 2 {
		t.Fatal("stale response cache survived database reload")
	}
}
