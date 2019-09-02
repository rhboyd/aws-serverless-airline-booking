import cdk = require('@aws-cdk/core');
import lambda = require('@aws-cdk/aws-lambda');
import ssm = require('@aws-cdk/aws-ssm');

export interface CatalogProps {
    readonly flightTable: string;
    readonly stage: string;
}

export class CatalogStack extends cdk.Stack {
    public readonly reserveFlightFunction: string
    public readonly releaseFlightFunction: string

    constructor(scope: cdk.App, id: string, props: CatalogProps) {
        super(scope, id);

        const reserveFlight = new lambda.Function(this, "ReserveFlight", {
            runtime: lambda.Runtime.PYTHON_3_7,
            timeout: cdk.Duration.seconds(10),
            code: new lambda.AssetCode('../src/backend/catalog/src/reserve-flight'),
            handler: 'reserve.lambda_handler'
        });
        // Here is one way to add environment variables to a Lambda Function
        reserveFlight.addEnvironment('FLIGHT_TABLE_NAME', props.flightTable);

        const releaseFlight = new lambda.Function(this, "ReleaseFlight", {
            runtime: lambda.Runtime.PYTHON_3_7,
            timeout: cdk.Duration.seconds(10),
            code: new lambda.AssetCode('../src/backend/catalog/src/release-flight'),
            handler: 'release.lambda_handler',
            // here is another way to add environment variables to a Lambda Function
            environment: {
                FLIGHT_TABLE_NAME: props.flightTable
            }
        });

        const reserveFlightParameter = new ssm.StringParameter(this, "ReserveFlightParameter", {
            parameterName: `/service/catalog/reserve-function/${props.stage}`,
            stringValue: reserveFlight.functionArn,
            description: "Reserve Flight Lambda ARN"
        });

        const releaseFlightParameter = new ssm.StringParameter(this, "ResleaseFlightParameter", {
            parameterName: `/service/catalog/release-function/${props.stage}`,
            stringValue: releaseFlight.functionArn,
            description: "Release Flight Lambda ARN"
        });

        this.reserveFlightFunction = reserveFlight.functionArn;
        this.releaseFlightFunction = releaseFlight.functionArn;
    }
}