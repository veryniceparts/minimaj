package main

import (
	"net"
	"sort"
	"strings"
)

var virtualIfacePrefixes = []string{
	"docker", "veth", "br-", "virbr", "vmnet", "vboxnet", "vnic", "utun", "tun", "tap",
	"zt", "tailscale", "wg", "ham", "llw", "awdl", "anpi", "ipsec", "ppp", "lxc", "lxd",
	"cni", "flannel", "cali", "kube", "podman", "vEthernet", "VirtualBox", "VMware", "Hyper-V",
	"rmnet", "ccmni", "dummy",
}

func isVirtualIface(name string) bool {
	l := strings.ToLower(name)
	for _, p := range virtualIfacePrefixes {
		if strings.HasPrefix(l, strings.ToLower(p)) {
			return true
		}
	}
	return false
}

// lanIPs returns private IPv4 addresses of up, non-virtual interfaces.
// Interface listing can fail on Android (netlink is restricted); then the
// address used for the default route is the fallback.
func lanIPs() []string {
	var out []string
	seen := map[string]bool{}
	add := func(ip net.IP) {
		ip4 := ip.To4()
		if ip4 == nil || !ip4.IsPrivate() || seen[ip4.String()] {
			return
		}
		seen[ip4.String()] = true
		out = append(out, ip4.String())
	}
	ifaces, err := net.Interfaces()
	if err == nil {
		for _, ifc := range ifaces {
			if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 || isVirtualIface(ifc.Name) {
				continue
			}
			addrs, err := ifc.Addrs()
			if err != nil {
				continue
			}
			for _, a := range addrs {
				if n, ok := a.(*net.IPNet); ok {
					add(n.IP)
				}
			}
		}
	}
	if len(out) == 0 {
		// No packets are sent: this only asks the OS which source address it would use.
		if c, err := net.Dial("udp4", "192.0.2.1:9"); err == nil {
			add(c.LocalAddr().(*net.UDPAddr).IP)
			c.Close()
		}
	}
	rank := func(s string) int {
		switch {
		case strings.HasPrefix(s, "192.168."):
			return 0
		case strings.HasPrefix(s, "10."):
			return 1
		default:
			return 2
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return rank(out[i]) < rank(out[j]) })
	return out
}
