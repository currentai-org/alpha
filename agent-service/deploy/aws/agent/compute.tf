# One instance per role, as on Fly: the gateway holds the model tokens and the agent never sees them, so they do not
# share a machine. Each runs one container from the same image, built on the instance from source deploy.sh uploads
# (host-setup.sh.tftpl). Shell access is SSM only; no SSH port, no key pair.

data "aws_ssm_parameter" "al2023" {
  count = var.ami == "" ? 1 : 0
  name  = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

locals {
  ami = var.ami != "" ? var.ami : one(data.aws_ssm_parameter.al2023[*].insecure_value)
  # Fixed private addresses: the agent pins the gateway by address in its egress filter (deploy/entrypoint.sh), and
  # a fixed one survives an instance replacement.
  agent_ip   = cidrhost(aws_subnet.a.cidr_block, 10)
  gateway_ip = cidrhost(aws_subnet.a.cidr_block, 11)
  roles = {
    agent   = { type = var.agent_instance_type, ip = local.agent_ip, sg = aws_security_group.agent.id, root_gb = 40 }
    gateway = { type = var.gateway_instance_type, ip = local.gateway_ip, sg = aws_security_group.gateway.id, root_gb = 30 }
  }
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "HTTPS from anywhere: the web app functions and E2B sandboxes have no fixed addresses; the bearer token and the nonce are the gate, as on Fly"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "alb" {
  for_each          = toset(["80", "443"])
  security_group_id = aws_security_group.alb.id
  ip_protocol       = "tcp"
  from_port         = tonumber(each.key)
  to_port           = tonumber(each.key)
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "alb" {
  security_group_id = aws_security_group.alb.id
  ip_protocol       = "-1"
  cidr_ipv4         = var.vpc_cidr
}

resource "aws_security_group" "agent" {
  name        = "${local.name}-agent"
  description = "The agent: 8731 from the load balancer only"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "agent_from_alb" {
  security_group_id            = aws_security_group.agent.id
  ip_protocol                  = "tcp"
  from_port                    = 8731
  to_port                      = 8731
  referenced_security_group_id = aws_security_group.alb.id
}

# Outbound is narrowed again inside the container by the nftables allowlist (deploy/entrypoint.sh); this rule only
# has to let the allowlisted destinations through.
resource "aws_vpc_security_group_egress_rule" "agent" {
  security_group_id = aws_security_group.agent.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "gateway" {
  name        = "${local.name}-gateway"
  description = "The gateway: 8732 (admin, grants) from the agent only, 8733 (nonce routes) from the load balancer only"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "gateway_private" {
  security_group_id            = aws_security_group.gateway.id
  ip_protocol                  = "tcp"
  from_port                    = 8732
  to_port                      = 8732
  referenced_security_group_id = aws_security_group.agent.id
}

resource "aws_vpc_security_group_ingress_rule" "gateway_public" {
  security_group_id            = aws_security_group.gateway.id
  ip_protocol                  = "tcp"
  from_port                    = 8733
  to_port                      = 8733
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_egress_rule" "gateway" {
  security_group_id = aws_security_group.gateway.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# Source tarballs deploy.sh uploads, one per develop commit. Instances read them; nothing else does.
resource "aws_s3_bucket" "source" {
  bucket        = "${local.name}-source-${data.aws_caller_identity.this.account_id}"
  force_destroy = true # rebuildable from git
}

resource "aws_s3_bucket_public_access_block" "source" {
  bucket                  = aws_s3_bucket.source.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "source" {
  bucket = aws_s3_bucket.source.id
  rule {
    id     = "expire-old-source"
    status = "Enabled"
    filter {}
    expiration {
      days = 30
    }
  }
}

resource "aws_iam_role" "host" {
  for_each = local.roles
  name     = "${local.name}-${each.key}"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

# What the SSM agent needs for Run Command (deploy.sh's releases) and Session Manager, and nothing more. Not the
# AmazonSSMManagedInstanceCore managed policy: it also grants ssm:GetParameter(s) on every parameter in the account,
# which with the KMS statement below would let a develop host read production's env.
resource "aws_iam_role_policy" "ssm_agent" {
  for_each = local.roles
  name     = "${local.name}-${each.key}-ssm-agent"
  role     = aws_iam_role.host[each.key].name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Resource = "*"
      Action = [
        "ssm:UpdateInstanceInformation",
        "ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel",
        "ec2messages:AcknowledgeMessage", "ec2messages:DeleteMessage", "ec2messages:FailMessage",
        "ec2messages:GetEndpoint", "ec2messages:GetMessages", "ec2messages:SendReply",
      ]
    }]
  })
}

# Each host reads its own env parameter and the source tarballs, nothing else. The containers cannot borrow these
# credentials: the metadata hop limit is 1, so a container on Docker's bridge never reaches the metadata service.
resource "aws_iam_role_policy" "host" {
  for_each = local.roles
  name     = "${local.name}-${each.key}-release"
  role     = aws_iam_role.host[each.key].name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.this.account_id}:parameter${local.env_param[each.key]}"
      },
      {
        Effect    = "Allow"
        Action    = ["kms:Decrypt"]
        Resource  = "*"
        Condition = { StringEquals = { "kms:ViaService" = "ssm.${var.region}.amazonaws.com" } }
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.source.arn}/src/*"
      },
    ]
  })
}

resource "aws_iam_instance_profile" "host" {
  for_each = local.roles
  name     = "${local.name}-${each.key}"
  role     = aws_iam_role.host[each.key].name
}

resource "aws_instance" "host" {
  for_each               = local.roles
  ami                    = local.ami
  instance_type          = each.value.type
  subnet_id              = aws_subnet.a.id
  private_ip             = each.value.ip
  vpc_security_group_ids = [each.value.sg]
  iam_instance_profile   = aws_iam_instance_profile.host[each.key].name

  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = each.value.root_gb
    encrypted   = true
  }

  user_data = templatefile("${path.module}/host-setup.sh.tftpl", {
    role      = each.key
    region    = var.region
    bucket    = aws_s3_bucket.source.id
    env_param = local.env_param[each.key]
    data_vol  = each.key == "agent" ? replace(aws_ebs_volume.agent_data.id, "-", "") : ""
  })

  tags = { Name = "${local.name}-${each.key}", role = each.key }

  lifecycle {
    # A host change is a new instance on purpose (README, Changing a host), never a drift an apply quietly acts on.
    ignore_changes = [ami, user_data]
  }
}

# tasks.db and session scratch outlive an instance replacement, as Fly's volume does a machine's.
resource "aws_ebs_volume" "agent_data" {
  availability_zone = local.zone_a
  size              = var.agent_data_gb
  type              = "gp3"
  encrypted         = true
  tags              = { Name = "${local.name}-agent-data" }
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_volume_attachment" "agent_data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.agent_data.id
  instance_id = aws_instance.host["agent"].id
}
