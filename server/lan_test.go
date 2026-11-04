package main

import (
	"reflect"
	"testing"
)

func TestRankIPs(t *testing.T) {
	ips := []string{"172.17.5.1", "10.0.0.7", "192.168.56.1", "192.168.1.20"}
	running := map[string]bool{"10.0.0.7": true, "192.168.1.20": true, "172.17.5.1": true}
	// the default-route address wins, then interfaces with a link, then by range
	got := rankIPs(ips, "10.0.0.7", running)
	want := []string{"10.0.0.7", "192.168.1.20", "172.17.5.1", "192.168.56.1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	// a default route through a VPN (not in the list) changes nothing
	got = rankIPs(ips, "10.8.0.2", running)
	want = []string{"192.168.1.20", "10.0.0.7", "172.17.5.1", "192.168.56.1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("vpn: got %v want %v", got, want)
	}
	if ips[0] != "172.17.5.1" {
		t.Fatal("input modified")
	}
}

func TestVirtualIfaces(t *testing.T) {
	for _, n := range []string{"docker0", "vEthernet (WSL)", "VirtualBox Host-Only Network", "utun3", "tailscale0", "rmnet_data0"} {
		if !isVirtualIface(n) {
			t.Errorf("%q should be virtual", n)
		}
	}
	for _, n := range []string{"wlan0", "en0", "Wi-Fi", "Ethernet", "eth0", "ap0", "swlan0"} {
		if isVirtualIface(n) {
			t.Errorf("%q should not be virtual", n)
		}
	}
}
