# A VPC of this stack's own, peered to the E2B stack's VPC. Not subnets inside the E2B VPC: that VPC belongs to the
# E2B module's state, a host cutover builds a new one beside it and destroys the old (../e2b/README.md), and a subnet
# of ours inside it would block that destroy. Peering keeps the two lifecycles apart: a cutover changes var.e2b_name
# and re-applies this root, which moves the peering and nothing else.
#
# The agent reaches the E2B API (3000) and sandbox proxy (3002) over the peering, so the WireGuard link app on Fly
# is not needed. Both ends use instance types that encrypt in transit on the Nitro card, which covers same-region
# peered traffic, so the plain-HTTP Embed ports never cross a network in the clear.

data "aws_vpc" "e2b" {
  tags = { Name = var.e2b_name }
}

data "aws_subnet" "e2b" {
  vpc_id = data.aws_vpc.e2b.id
  tags   = { Name = var.e2b_name }
}

data "aws_route_table" "e2b" {
  subnet_id = data.aws_subnet.e2b.id
}

data "aws_security_group" "e2b" {
  vpc_id = data.aws_vpc.e2b.id
  name   = var.e2b_name
}

# The E2B host's fixed public address. Its public DNS name resolves to the host's private address from a peered VPC
# that allows remote DNS resolution (below), so the agent's E2B URLs name it and survive the Auto Scaling group
# replacing the instance.
data "aws_eip" "e2b" {
  tags = { Name = var.e2b_name }
}

data "aws_availability_zones" "up" {
  state = "available"
}

locals {
  # The instances share the E2B host's zone: same-zone traffic is free and one zone fewer to fail. The load balancer
  # needs a second zone, which only it uses.
  zone_a = data.aws_subnet.e2b.availability_zone
  zone_b = sort([for z in data.aws_availability_zones.up.names : z if z != local.zone_a])[0]
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = local.name }
}

# Public subnets with no NAT: the instances take a public address for outbound traffic only (model providers, Axiom,
# the safety screen, Docker Hub at build), and their security groups admit nothing from the internet.
resource "aws_subnet" "a" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 0)
  availability_zone       = local.zone_a
  map_public_ip_on_launch = true
  tags                    = { Name = "${local.name}-a" }
  lifecycle {
    ignore_changes = [availability_zone] # chosen once; moving it would replace both instances
  }
}

resource "aws_subnet" "b" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 1)
  availability_zone       = local.zone_b
  map_public_ip_on_launch = true
  tags                    = { Name = "${local.name}-b" }
  lifecycle {
    ignore_changes = [availability_zone]
  }
}

resource "aws_route_table" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = local.name }
}

resource "aws_route" "internet" {
  route_table_id         = aws_route_table.this.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "a" {
  subnet_id      = aws_subnet.a.id
  route_table_id = aws_route_table.this.id
}

resource "aws_route_table_association" "b" {
  subnet_id      = aws_subnet.b.id
  route_table_id = aws_route_table.this.id
}

resource "aws_vpc_peering_connection" "e2b" {
  vpc_id      = aws_vpc.this.id
  peer_vpc_id = data.aws_vpc.e2b.id
  auto_accept = true # same account and region
  tags        = { Name = "${local.name}-to-${var.e2b_name}" }
}

resource "aws_vpc_peering_connection_options" "e2b" {
  vpc_peering_connection_id = aws_vpc_peering_connection.e2b.id
  # The accepter is the E2B VPC: this lets instances here (the agent) resolve its public DNS names, the E2B host's
  # among them, to private addresses. The E2B module enables DNS hostnames on its VPC, which this needs.
  accepter {
    allow_remote_vpc_dns_resolution = true
  }
}

resource "aws_route" "to_e2b" {
  route_table_id            = aws_route_table.this.id
  destination_cidr_block    = data.aws_vpc.e2b.cidr_block
  vpc_peering_connection_id = aws_vpc_peering_connection.e2b.id
}

# The return route lives in the E2B module's route table. The module manages its routes as separate resources
# (aws_route.internet), so a route added from here is not removed by the next E2B apply.
resource "aws_route" "from_e2b" {
  route_table_id            = data.aws_route_table.e2b.id
  destination_cidr_block    = var.vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.e2b.id
}

# The E2B host admits the agent instance, and only it, on the API and the sandbox proxy. The gateway never talks to
# E2B. Traffic arrives on the host's primary interface, which its WireGuard firewall chains do not match.
resource "aws_vpc_security_group_ingress_rule" "e2b_from_agent" {
  for_each                     = toset(["3000", "3002"])
  security_group_id            = data.aws_security_group.e2b.id
  description                  = "E2B ${each.key == "3000" ? "API" : "sandbox proxy"} from ${local.name} agent, over the peering"
  ip_protocol                  = "tcp"
  from_port                    = tonumber(each.key)
  to_port                      = tonumber(each.key)
  referenced_security_group_id = aws_security_group.agent.id
  depends_on                   = [aws_vpc_peering_connection.e2b]
}
