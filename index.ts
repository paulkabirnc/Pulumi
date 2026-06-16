// RAZR Take home Task
//  

import * as pulumi from "@pulumi/pulumi"
import * as aws from "@pulumi/aws"
import { Environment } from "@pulumi/aws/appconfig";
import { LineGraphMetricWidget } from "@pulumi/awsx/classic/cloudwatch";



// --- CONFIGURATION  --

//  Environment specific values from Pulumi config

const config = new pulumi.Config();
const environment = config.get("environment") || "dev";
const taskCount = config.getNumber("taskCount") || 1;


// Default VPC
const vpc = aws.ec2.getVpc({default: true});

// Get all Ssubnets in the VPC for the containers
const subnetIds = vpc.then(v=>
    aws.ec2.getSubnets({ filters: [{ name: "vpc-id", values: [v.id]}]}).then(s => s.ids)
);


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

tags: {
    Name:  `java-app-sg-${environment}`,
    Environment: environment

}

});


//  IAM Roles  - Execution Role for Fargate 

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


//  AWS managed policy for ECS task execution

new aws.iam.RolePolicyAttachment(`ecs-execution-policy-${environment}`, {

        role: executionRole.name,
        policyArn: "arn:aws:iam::aws:policy/service-role/AmazoneECSTaskExecutionRolePolicy"

});

// Task role - used by the containers
// Needs SSM permissions for ECS Exec ( SSH into containers)

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


// SSM Policy to enable SSH into containers through ECS Exec

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



// CloudWatch Log Group

const logGroup = new aws.cloudwatch.LogGroup(`fargate-logs-${environment}`, {
    retentionInDays: 7,
    tags: { Environment: environment}

});


// ECS Cluster
// Runs Fargate tasks

const cluster = new aws.ecs.Cluster(`java-cluster-${environment}`, {
    tags: {Environment: environment}
});




// Task definition
// Both containers Java App and PgBouncer 

const taskDefinition = new aws.ecs.TaskDefinition(`java-task-${environment}`, {
    family: `java-pgbouncer-${environment}`,
    cpu: "512",
    memory: "1024",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    executionRoleArn: executionRole.arn,
    taskRoleArn: taskRole.arn,
    containerDefinitions: pulumi.all([logGroup.name]).apply(([lgName]) =>
        JSON.stringify([
            {
                name: "java-app",
                image: "amazoncorretto:17",
                essential: true,
                portMappings: [{
                    containerPort: 8080,
                    protocol: "tcp"
                }],
                environment: [
                    { name: "ENVIRONMENT", value: environment },
                    { name: "DB_HOST", value: "localhost" },
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
                name: "pgbouncer",
                image: "pgbouncer/pgbouncer:latest",
                essential: false,
                portMappings: [{
                    containerPort: 5432,
                    protocol: "tcp"
                }],
                environment: [
                    { name: "DATABASES_HOST", value: "your-rds-endpoint" },
                    { name: "DATABASES_PORT", value: "5432" },
                    { name: "DATABASES_DBNAME", value: "appdb" },
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


// ── FARGATE SERVICE
// Runs the task with configurable count per environment
// enableExecuteCommand enables SSH into containers!

const service = new aws.ecs.Service(`java-service-${environment}`, {
    cluster: cluster.arn,
    taskDefinition: taskDefinition.arn,
    desiredCount: taskCount,
    launchType: "FARGATE",
    enableExecuteCommand: true,
    networkConfiguration: {
        assignPublicIp: true,
        subnets: subnetIds,
        securityGroups: [sg.id]
    },
    tags: { 
        Environment: environment, 
        ManagedBy: "Pulumi" 
    }
});

// ── EXPORTS 
// Values shown after pulumi up completes

export const clusterName = cluster.name;
export const serviceName = service.name;
export const taskFamily = taskDefinition.family;
export const environmentName = environment;
export const taskCountDeployed = taskCount;
export const ecsExecCommand = pulumi.interpolate
    `aws ecs execute-command --cluster ${cluster.name} --task <TASK_ID> --container java-app --interactive --command "/bin/bash"`;




