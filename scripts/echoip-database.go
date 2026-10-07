package geo

import "time"

// Report the metadata from the readers actually used for lookups, including
// custom database paths and explicitly disabled databases.
func (g *geoip) DatabaseDates() map[string]string {
	dates := make(map[string]string)
	if g.asn != nil {
		dates["ASN"] = time.Unix(int64(g.asn.Metadata().BuildEpoch), 0).UTC().Format(time.RFC3339)
	}
	if g.city != nil {
		dates["City"] = time.Unix(int64(g.city.Metadata().BuildEpoch), 0).UTC().Format(time.RFC3339)
	}
	if g.country != nil {
		dates["Country"] = time.Unix(int64(g.country.Metadata().BuildEpoch), 0).UTC().Format(time.RFC3339)
	}
	return dates
}
