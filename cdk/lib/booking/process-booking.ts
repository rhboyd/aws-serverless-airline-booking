import cdk = require('@aws-cdk/core');
import iam = require('@aws-cdk/aws-iam');
import lambda = require('@aws-cdk/aws-lambda');
import sfn = require('@aws-cdk/aws-stepfunctions');
import sfn_tasks = require('@aws-cdk/aws-stepfunctions-tasks');

export interface ProcessBookingConstructProps {
    readonly reserveBookingArn: string;
    readonly cancelBookingArn: string;
    readonly confirmBookingArn: string;
    readonly notifyBookingArn: string;
    readonly collectPaymentArn: string;
    readonly refundPaymentArn: string;
    readonly bookingTable: string;
    readonly flightTable: string;
}

/**
 * Properties for InvokeFunction
 */
export interface InvokeFunctionProps {
    /**
     * The JSON that you want to provide to your Lambda function as input.
     *
     * This parameter is named as payload to keep consistent with RunLambdaTask class.
     *
     * @default - The JSON data indicated by the task's InputPath is used as payload
     */
    readonly parameters?: { [key: string]: any };

    
}

export class DynamoDBUpdateItem implements sfn.IStepFunctionsTask {
    constructor(private readonly props: InvokeFunctionProps) {
    }
  
    public bind(_task: sfn.Task): sfn.StepFunctionsTaskConfig {
      return {
        resourceArn: "arn:aws:states:::dynamodb:updateItem",
        parameters: this.props.parameters
      };
    }
}

export class InvokeLambda implements sfn.IStepFunctionsTask {
    constructor(private readonly lambdaArn: string) {
    }
  
    public bind(_task: sfn.Task): sfn.StepFunctionsTaskConfig {
      return {
        resourceArn: `${this.lambdaArn}`
      };
    }
}

export class ProcessBookingConstruct extends cdk.Construct {
    public readonly stateMachineArn: string;

    constructor(scope: cdk.Stack, id: string, props: ProcessBookingConstructProps) {
        super(scope, id);
        const statesExecutionRole = new iam.Role(scope, "StatesExecutionRole", {
            assumedBy: new iam.ServicePrincipal('states'),
            path: '/',
            inlinePolicies: {
                StatesExecutionPolicy: new iam.PolicyDocument({
                    assignSids: true,
                    statements: [
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ["lambda:InvokeFunction"],
                            resources: [
                                props.reserveBookingArn,
                                props.cancelBookingArn,
                                props.confirmBookingArn,
                                props.notifyBookingArn,
                                props.collectPaymentArn,
                                props.refundPaymentArn
                            ]
                        })
                    ]
                }),
                DynamoDBCRUD: new iam.PolicyDocument({
                    assignSids: true,
                    statements: [
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ["dynamodb:*"],
                            resources: [
                                `arn:${cdk.Aws.PARTITION}:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${props.bookingTable}`,
                                `arn:${cdk.Aws.PARTITION}:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${props.flightTable}`,
                            ]
                        })
                    ]
                })     
            }
        })

        const bookingFailed = new sfn.Fail(this, "BookingFailed")

        const notifyBookingFailed = new sfn.Task(this, "NotifyBookingFailed", {
            task: new InvokeLambda(props.notifyBookingArn),
            timeout: cdk.Duration.seconds(5),
            resultPath: "$.notificationId",

        })
        .addRetry({
            errors: ["BookingNotificationException"],
            interval: cdk.Duration.seconds(1),
            backoffRate: 2,
            maxAttempts: 2
        });
        
        notifyBookingFailed.next(bookingFailed)

        /**
         * Release Flight Task and Retries
         */
        const releaseFlightTask = new sfn.Task(this, "ReleaseFlightTask", {
            task: new DynamoDBUpdateItem({
                parameters: {
                    "TableName.$": "$.flightTable",
                    "Key": {
                        "id": {
                            "S.$": "$.outboundFlightId"
                        }
                    },
                    "UpdateExpression": "SET seatAllocation = seatAllocation - :dec",
                        "ExpressionAttributeValues": {
                            ":dec": {
                                "N": "1"
                            },
                            ":noSeat": {
                                "N": "0"
                            }
                        },
                        "ConditionExpression": "seatAllocation > :noSeat"
                }
            }),
            timeout: cdk.Duration.seconds(5),
        })
        .addRetry({
            errors: [
                "ProvisionedThroughputExceededException",
                "RequestLimitExceeded",
                "ServiceUnavailable",
                "ThrottlingException"
            ],
            interval: cdk.Duration.seconds(1),
            backoffRate: 2,
            maxAttempts: 2
        })
        .addCatch(
            notifyBookingFailed,
            {
                resultPath: "$.flightError"
            }
        );
        releaseFlightTask.next(notifyBookingFailed)

        const cancelBooking = new sfn.Task(this, "CancelBooking", {
            task: new InvokeLambda(props.cancelBookingArn),
        })
        .addRetry({
            errors: ["BookingCancellationException"],
            interval: cdk.Duration.seconds(1),
            backoffRate: 2,
            maxAttempts: 2
        });

        cancelBooking.next(releaseFlightTask);

        /**
         * Reserve Flight Task and Retries
         */
        const reserveFlightTask = new sfn.Task(this, "ReserveFlightTask", {
            task: new DynamoDBUpdateItem({
                parameters: {
                    "TableName.$": "$.flightTable",
                    "Key": {
                        "id": {
                            "S.$": "$.outboundFlightId"
                        }
                    },
                    "UpdateExpression": "SET seatAllocation = seatAllocation +:inc",
                    "ExpressionAttributeValues": {
                        ":inc": {
                            "N": "1"
                        }
                    }
                }
            }),
            timeout: cdk.Duration.seconds(5),
        })
        .addRetry({
            errors: [
                "ProvisionedThroughputExceededException",
                "RequestLimitExceeded",
                "ServiceUnavailable",
                "ThrottlingException"
            ],
            interval: cdk.Duration.seconds(1),
            backoffRate: 2,
            maxAttempts: 2
        })
        .addRetry({
            errors: ["ConditionalCheckFailedException"],
            interval: cdk.Duration.seconds(0),
            maxAttempts: 0
        })
        .addCatch(
            notifyBookingFailed,
            {
                resultPath: "$.flightError"
            }
        );

        

        const reserveBooking = new sfn.Task(this, "ReserveBooking", {
            task: new InvokeLambda(props.reserveBookingArn),
            timeout: cdk.Duration.seconds(5),
            resultPath: "$.bookingId"
        })
        .addRetry({
            errors: ["BookingReservationException"],
            interval: cdk.Duration.seconds(1),
            backoffRate: 2,
            maxAttempts: 2
        })
        .addCatch(
            cancelBooking,
            {
                resultPath: "$.bookingError"
            }
        );

        const collectPayment = new sfn.Task(this, "CollectPayment", {
            task: new InvokeLambda(props.collectPaymentArn),
        })
        .addCatch(
            cancelBooking,
            {
                resultPath: "$.bookingError"
            }
        );


        const refundPayment = new sfn.Task(this, "RefundPayment", {
            task: new InvokeLambda(props.refundPaymentArn),
        });
        refundPayment.next(cancelBooking)

        const confirmBooking = new sfn.Task(this, "ConfirmBooking", {
            task: new InvokeLambda(props.confirmBookingArn),
            resultPath: "$.bookingReference"
        })
        .addRetry({
            errors: ["BookingConfirmationException"],
            interval: cdk.Duration.seconds(1),
            backoffRate: 2,
            maxAttempts: 2
        })
        .addCatch(
            refundPayment,
            {
                resultPath: "$.bookingError"
            }
        );

        const notifyBookingConfirmed = new sfn.Task(this, "Notify Booking Confirmed", {
            task: new InvokeLambda(props.notifyBookingArn),
            resultPath: "$.notificationId",
        })
        .addRetry({
            errors: ["BookingNotificationException"],
            interval: cdk.Duration.seconds(1),
            backoffRate: 2,
            maxAttempts: 2
        });

        const bookingConfirmed = new sfn.Succeed(this, "BookingConfirmed")
        
        const chain = sfn.Chain
            .start(reserveFlightTask)
            .next(reserveBooking)
            .next(collectPayment)
            .next(confirmBooking)
            .next(notifyBookingConfirmed)
            .next(bookingConfirmed)

        const stateMachine = new sfn.StateMachine(this, 'StateMachine', {
            definition: chain,
            timeout: cdk.Duration.seconds(30),
            role: statesExecutionRole
        });
        this.stateMachineArn = stateMachine.stateMachineArn;
    }
}