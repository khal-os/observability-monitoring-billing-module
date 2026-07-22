type MongoDbPort = number;
type MongoDbAtlas = boolean;
type MongoDbHost = string;
type MongoDbName = string;
type MongoDbPassword = string;
type MongoDbUser = string;

export interface MongoDbEnvironmentVariables {
  mongoDbPort?: MongoDbPort;
  mongoDbAtlas?: MongoDbAtlas;
  mongoDbHost?: MongoDbHost;
  mongoDbName?: MongoDbName;
  mongoDbPassword?: MongoDbPassword;
  mongoDbUser?: MongoDbUser;
}
