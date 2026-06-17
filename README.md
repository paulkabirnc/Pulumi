# RAZR Fargate Assignment — Java App + PgBouncer Sidecar

Overview
Pulumi TypeScript program that deploys a Fargate service running a Java application 
server alongside a PgBouncer sidecar container, with full multi-environment support 
and SSH access into containers via ECS Exec.

Architecture
- ECS Fargate — serverless container hosting, no EC2 management required
- Two-container task — Java app (port 8080) + PgBouncer sidecar (port 5432)
- Sidecar pattern — Java app connects to localhost:5432, PgBouncer pools 
  connections to the real PostgreSQL database
- Default VPC — uses existing AWS default VPC and subnets per region

Requirements
1. Configurable task count — set via `pulumi config set taskCount N`
2. Multi-environment — separate Pulumi stacks (dev/staging/prod), each with 
   independent config and fully isolated AWS resources
3. SSH into containers — ECS Exec enabled (`enableExecuteCommand: true`), 
   using AWS Systems Manager. Command provided in stack outputs.
4. GitHub repo — this repository
5. References — see below

## Environments
| Stack   | Task Count | Region    |
|---------|-----------|-----------|
| dev     | 1         | us-west-2 |
| staging | 2         | us-west-2 |
| prod    | 3         | us-west-2 |

How to Deploy
============
pulumi stack select dev
pulumi up

#How to SSH into the Java Container
After deployment, get the task ID:

aws ecs list-tasks --cluster java-cluster-dev --service-name java-service-dev

Then exec in:
aws ecs execute-command --cluster java-cluster-dev --task <TASK_ID> \
  --container java-app --interactive --command "/bin/bash"

References
- AWS ECS Exec documentation: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-exec.html
- PgBouncer Docker image: https://hub.docker.com/r/pgbouncer/pgbouncer
- Amazon Corretto Java image: https://hub.docker.com/_/amazoncorretto
- Pulumi AWS provider docs: https://www.pulumi.com/registry/packages/aws/

Assumptions Made
- Used existing default VPC/subnets rather than creating new networking, 
  to keep the assignment focused on the Fargate service itself
- PgBouncer database connection details are placeholders





  (`your-rds-endpoint`) — would point to actual RDS instance in production
- Security group allows broad ingress/egress for demo purposes — production 
  would restrict to load balancer and database security groups specifically
