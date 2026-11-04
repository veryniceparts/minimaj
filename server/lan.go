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

// lanIPs returns private IPv4 addresses of up, non-virtual interfaces, best
// first: the address the OS uses for its default route (the real Wi-Fi or
// Ethernet, usually), then interfaces with a link, then 192.168/10/172.16.
// Interface listing can fail on Android (netlink is restricted); then the
// default-route address is the fallback.
func lanIPs() []string {
	var ips []string
	running := map[string]bool{}
	seen := map[string]bool{}
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
				n, ok := a.(*net.IPNet)
				if !ok {
					continue
				}
				if ip4 := n.IP.To4(); ip4 != nil && ip4.IsPrivate() && !seen[ip4.String()] {
					seen[ip4.String()] = true
					ips = append(ips, ip4.String())
					if ifc.Flags&net.FlagRunning != 0 {
						running[ip4.String()] = true
					}
				}
			}
		}
	}
	primary := defaultRouteIP()
	if len(ips) == 0 && primary != "" {
		ips = append(ips, primary)
	}
	return rankIPs(ips, primary, running)
}

// defaultRouteIP is the private source address the OS would use to reach the
// internet, or "". No packets are sent: dialing UDP only picks a route.
func defaultRouteIP() string {
	c, err := net.Dial("udp4", "192.0.2.1:9")
	if err != nil {
		return ""
	}
	defer c.Close()
	ip := c.LocalAddr().(*net.UDPAddr).IP.To4()
	if ip == nil || !ip.IsPrivate() {
		return ""
	}
	return ip.String()
}

// rankIPs orders candidate addresses: the default-route address (only if it
// is on a real interface, i.e. in ips: a VPN's tunnel address is not), then
// interfaces with a link up, then by private range.
func rankIPs(ips []string, primary string, running map[string]bool) []string {
	out := append([]string(nil), ips...)
	rank := func(s string) int {
		r := 0
		switch {
		case strings.HasPrefix(s, "192.168."):
		case strings.HasPrefix(s, "10."):
			r = 1
		default:
			r = 2
		}
		if running != nil && !running[s] {
			r += 10
		}
		if s == primary {
			r = -1
		}
		return r
	}
	sort.SliceStable(out, func(i, j int) bool { return rank(out[i]) < rank(out[j]) })
	return out
}
