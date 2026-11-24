output "certificate_validation_records" {
  description = "The DNS records that validate the certificate. Add each as a CNAME in the zone that holds the two names."
  value = [for o in aws_acm_certificate.this.domain_validation_options :
  { name = o.resource_record_name, type = o.resource_record_type, value = o.resource_record_value }]
}

output "alb_dns_name" {
  description = "Point agent_hostname and gateway_hostname at this with a CNAME each."
  value       = aws_lb.this.dns_name
}

# deploy.sh reads the outputs below; README names what each becomes.

output "deploy" {
  description = "What deploy.sh needs to render each role's env and release it. No secrets."
  value = {
    stack           = var.stack
    region          = var.region
    bucket          = aws_s3_bucket.source.id
    env_param       = local.env_param
    instance_id     = { for k, v in aws_instance.host : k => v.id }
    agent_url       = "https://${var.agent_hostname}"
    gateway_url     = "https://${var.gateway_hostname}"
    gateway_private = "http://${local.gateway_ip}:8732"
    e2b_api_url     = "http://${data.aws_eip.e2b.public_dns}:3000"
    e2b_sandbox_url = "http://${data.aws_eip.e2b.public_dns}:3002"
    alb_dns_name    = aws_lb.this.dns_name
  }
}
