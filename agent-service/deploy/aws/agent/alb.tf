# The public front door, in place of Fly's edge: TLS for both names on one load balancer, routed by host. The web
# app calls the agent name; E2B sandboxes call the gateway name for model nonces (their host drops forwarded traffic
# to private ranges, so they cannot use the gateway's private port).
#
# The certificate is validated by DNS records someone with the zone adds by hand (README, Stand up): the first apply
# targets the certificate alone and prints them, the second waits for validation and builds the rest.

resource "aws_acm_certificate" "this" {
  domain_name               = var.agent_hostname
  subject_alternative_names = [var.gateway_hostname]
  validation_method         = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "this" {
  certificate_arn = aws_acm_certificate.this.arn
  timeouts {
    create = "30m"
  }
}

resource "aws_lb" "this" {
  name               = local.name
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [aws_subnet.a.id, aws_subnet.b.id]
  # A task streams for up to AGENT_WALL_CLOCK_SECS plus confirmation waits; an idle stream must outlast both.
  idle_timeout               = 900
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "agent" {
  name     = "${local.name}-agent"
  port     = 8731
  protocol = "HTTP"
  vpc_id   = aws_vpc.this.id
  # serve.py drains running tasks on SIGTERM for up to 300 s (Fly's kill_timeout); deregistration waits as long.
  deregistration_delay = 300
  health_check {
    path                = "/healthz"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }
}

resource "aws_lb_target_group" "gateway" {
  name                 = "${local.name}-gw"
  port                 = 8733
  protocol             = "HTTP"
  vpc_id               = aws_vpc.this.id
  deregistration_delay = 60
  health_check {
    path                = "/healthz"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }
}

resource "aws_lb_target_group_attachment" "agent" {
  target_group_arn = aws_lb_target_group.agent.arn
  target_id        = aws_instance.host["agent"].id
}

resource "aws_lb_target_group_attachment" "gateway" {
  target_group_arn = aws_lb_target_group.gateway.arn
  target_id        = aws_instance.host["gateway"].id
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.this.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.agent.arn
  }
}

resource "aws_lb_listener_rule" "gateway" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  condition {
    host_header {
      values = [var.gateway_hostname]
    }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }
}
