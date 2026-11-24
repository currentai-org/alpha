# The agent service and its model gateway on EC2, beside an E2B stack (README.md). One stack per environment, each in
# its own workspace: default is develop. The account comes from AWS_PROFILE and the region from var.region, so a
# second account is the same apply with a different profile and state bucket.

terraform {
  required_version = ">= 1.10"
  # State holds no secret: the services' env lives in SSM parameters that deploy.sh writes from Doppler, never here.
  # The bucket and region are passed at init (README), which keeps the account out of source.
  backend "s3" {
    key          = "agent/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.33, < 7.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = local.tags
  }
}

# The same guard as ../e2b: an apply whose stack disagrees with its workspace would rename one environment's live
# hosts into the other's.
resource "terraform_data" "stack_matches_workspace" {
  lifecycle {
    precondition {
      condition     = var.stack == (terraform.workspace == "default" ? "develop" : terraform.workspace)
      error_message = "stack ${var.stack} does not match workspace ${terraform.workspace}: select the workspace that holds this stack's state."
    }
  }
}

locals {
  name = "potluck-agent-${var.stack}"
  tags = { project = "agent-service", stack = var.stack }
  # The SSM parameters deploy.sh writes, one per role. The instance role may read only its own.
  env_param = { for role in ["agent", "gateway"] : role => "/${local.name}/${role}/env" }
}

data "aws_caller_identity" "this" {}
