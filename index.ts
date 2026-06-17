// RAZR Take home Task
//  

import * as pulumi from "@pulumi/pulumi"
import * as aws from "@pulumi/aws"
import { Environment } from "@pulumi/aws/appconfig";
import { LineGraphMetricWidget } from "@pulumi/awsx/classic/cloudwatch";



// --- CONFIGURATION  --

//  Environment specific values from Pulumi config

const config = new pulumi.Config();  // config reader pulls data from pulumi.dev.yaml/ pulumi.staging/yaml
const environment = config.get("environment") || "dev"; 
const taskCount = config.getNumber("taskCount") || 1;


// Get the Default VPC
const vpc = aws.ec2.getVpc({default: true}); 

// Get all Ssubnets in the VPC for the containers per Fargate
const subnetIds = vpc.then(v=>
    aws.ec2.getSubnets({ filters: [{ name: "vpc-id", values: [v.id]}]}).then(s => s.ids)
);

//  SG acts as a Firewall for Fargate tasks, opened port 8080 for Java app and outbound traffic for pgBouncer to reach the DB
// However, for production, ingress should be pointed to Load Balancer SG, and egress to db SG only.

const sg = new aws.ec2.SecurityGroup(`java-app-sg-${environment}`,
    {description: `Security group Java app - ${environment}`, 

    ingress: [
        {
            protocol: "tcp",
            fromPort: 8080,
            toPort: 8080,
            cidrBlocks: ["0.0.0.0/0"],
            description: " Java app port"
        }
    ],

egress: [
{
    protocol: "-1",
    fromPort: 0,
    toPort:0,
    cidrBlocks: ["0.0.0.0/0"],
    description: " Allow all outbound"
}
],
//  Keeping track of the environment
tags: {
    Name:  `java-app-sg-${environment}`,
    Environment: environment

}

});


//  IAM Roles  - Execution Role for Fargate to pull docker images from ECR and CloudWatch logs
//  Restricting it ecs-tasks usage only

const executionRole = new aws.iam.Role(`ecs-execution-role-${environment}`, {
    assumeRolePolicy: JSON.stringify ({
        version:  "2012-10-17",
        Statement: [ {
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: { Service: "ecs-tasks, amazonaws.com"}
        }]

    }),

    tags: {Environment: environment}

});


//  AWS managed policy for ECS  execution role

new aws.iam.RolePolicyAttachment(`ecs-execution-policy-${environment}`, {

        role: executionRole.name,
        policyArn: "arn:aws:iam::aws:policy/service-role/AmazoneECSTaskExecutionRolePolicy"

});

// Task role - used by the Containers ( Java App, pgBouncer)

const taskRole = new aws.iam.Role(`ecs-task-role-${environment}`, {

    assumeRolePolicy: JSON.stringify( {

        Version: "2012-10-17",
        Statement: [{
                Action: "sts:AssumeRole",
                Effect: "Allow",
                Principal: { Service: "ecs-tasks.amazonaws.com" }

        }]
}),
    tags: {Environment: environment}
});

// Requirement#3
// ------- 2 Roles ---- 
// Execution role- Images, logs
// Task role - 
// The task role allows running containers permission to use SSM which powers ECS Exec.
// SSM permissions for ECS Exec ( SSH into containers using AWS System manager)
// SSM Policy to enable SSH into containers through ECS Exec
// Benefit:  If containers are compromised, Fargate is still intact

    new aws.iam.RolePolicy(`ecs-exec-policy-${environment}`, {

            role: taskRole.name,
            policy: JSON.stringify( {
                    version: "2012-10-17",
                    Statement: [ {
                        Effect: "Allow",
                        Action: [
                            "ssmmessages:CreateControlChannel",
                            "ssmmessages:CreateDataChannel",
                            "ssmmessages:OpenControlChannel",
                            "ssmmessages:OpenDataChannel"

                        ],
                        Resource: "*"


                    }]

            })
    });


// Each environment gets its own cloudWatch and ECS Cluster
// CloudWatch Log Group used by both Java App & pgBouncer environment specific

const logGroup = new aws.cloudwatch.LogGroup(`fargate-logs-${environment}`, {
    retentionInDays: 7,
    tags: { Environment: environment}

});

// Environment specific ECS Cluster
// 

const cluster = new aws.ecs.Cluster(`java-cluster-${environment}`, {
    tags: {Environment: environment}
});


// Task definition
// Defines both containers Java App and PgBouncer run in the same task

const taskDefinition = new aws.ecs.TaskDefinition(`java-task-${environment}`, {
    family: `java-pgbouncer-${environment}`,
    cpu: "512",
    memory: "1024",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],  // Not EC2
    executionRoleArn: executionRole.arn,  // images, logs
    taskRoleArn: taskRole.arn,            // Roles used by the containers ( ECS Exec/SSH)
    containerDefinitions: pulumi.all([logGroup.name]).apply(([lgName]) =>
        JSON.stringify([
            {
                // Container #1  Java App
                name: "java-app",
                image: "amazoncorretto:17",
                essential: true,
                portMappings: [{
                    containerPort: 8080,
                    protocol: "tcp"
                }],
                environment: [
                    { name: "ENVIRONMENT", value: environment },
                    { name: "DB_HOST", value: "localhost" },   // Java App connects to localhost, pgBouncer shares the same task
                    { name: "DB_PORT", value: "5432" }
                ],
                logConfiguration: {
                    logDriver: "awslogs",
                    options: {
                        "awslogs-group": lgName,
                        "awslogs-region": "us-west-2",
                        "awslogs-stream-prefix": "java-app"
                    }
                }
            },
            {
                // Container #2  pgBouncer - Sidecar
                // Java App connects here and pgBouncer pools data from the real DB.
                name: "pgbouncer",
                image: "pgbouncer/pgbouncer:latest",
                essential: false,
                portMappings: [{
                    containerPort: 5432,  
                    protocol: "tcp"
                }],
                environment: [
                    { name: "DATABASES_HOST", value: "real-rds-endpoint" },
                    { name: "DATABASES_PORT", value: "5432" },
                    { name: "DATABASES_DBNAME", value: "RAZRDB" },
                    { name: "PGBOUNCER_POOL_MODE", value: "transaction" },
                    { name: "PGBOUNCER_MAX_CLIENT_CONN", value: "100" }
                ],
                logConfiguration: {
                    logDriver: "awslogs",
                    options: {
                        "awslogs-group": lgName,
                        "awslogs-region": "us-west-2",
                        "awslogs-stream-prefix": "pgbouncer"
                    }
                }
            }
        ])
    )
});


//              ------   FARGATE SERVICE   -------
// Runs the task with configurable count per environment
// enableExecuteCommand enables SSH into containers!

const service = new aws.ecs.Service(`java-service-${environment}`, {
    cluster: cluster.arn,
    taskDefinition: taskDefinition.arn,
    desiredCount: taskCount,       // Requirement #1
    launchType: "FARGATE",
    enableExecuteCommand: true,    // Requirement #3  SSH Mechanism, Enables ECS exec using AWS System Manager
    networkConfiguration: {
        assignPublicIp: true,      // For contianers to pull Docker images
        subnets: subnetIds,
        securityGroups: [sg.id]    // Applies security group firewall rules.
    },
    tags: { 
        Environment: environment, 
        ManagedBy: "Pulumi" 
    }
});

// EXPORTS 
// Values shown after pulumi up completes

export const clusterName = cluster.name;
export const serviceName = service.name;
export const taskFamily = taskDefinition.family;
export const environmentName = environment;
export const taskCountDeployed = taskCount;
export const ecsExecCommand = pulumi.interpolate
    `aws ecs execute-command --cluster ${cluster.name} --task <TASK_ID> --container java-app --interactive --command "/bin/bash"`;




