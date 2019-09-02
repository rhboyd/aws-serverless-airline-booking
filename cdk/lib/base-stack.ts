import ddb = require('@aws-cdk/aws-dynamodb');
import cdk = require('@aws-cdk/core');

export class BaseStack extends cdk.Stack {
  public readonly flightTableName: string;
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const flightTable = new ddb.Table(this, "FlightsTable", {
      partitionKey: {name: "partitionKey", type: ddb.AttributeType.STRING},
      sortKey: {name: "sortKey", type: ddb.AttributeType.STRING},
    })
    this.flightTableName = flightTable.tableName
    
  }
}
