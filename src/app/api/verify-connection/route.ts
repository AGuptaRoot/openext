import { NextResponse } from 'next/server';
import fs from 'fs';
import { getMongoBaseConnection } from '@/utils/db';
import path from 'path';
import { getDynamicEnv } from '@/utils/dynamicEnv';
import { withDbName } from '@/utils/mongoUri';
import { isMysql, isPostgres } from '@/lib/db/config';
import { getMysqlPool, getMysqlDatabaseName } from '@/lib/db/mysql/adapter';
import { getPostgresPool, getPostgresDatabaseName } from '@/lib/db/postgres/adapter';

function createConnectionUri(dbName: string) {
  const {
    MONGODB_USERNAME,
    MONGODB_PASSWORD,
    MONGODB_HOST,
    MONGODB_CLUSTER,
    MONGODB_AUTH_MECH,
    MONGODB_AUTH_SOURCE,
    MONGODB,
    MONGODB_URI,
  } = getDynamicEnv();

  if (MONGODB === 'uri') {
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI is required when MONGODB=uri');
    }
    return withDbName(MONGODB_URI, dbName);
  }

  if (!MONGODB_USERNAME || !MONGODB_PASSWORD || !MONGODB_HOST || !MONGODB) {
    throw new Error('Missing required MongoDB environment variables');
  }

  if (MONGODB === 'atlas') {
    if (!MONGODB_CLUSTER) {
      throw new Error('MONGODB_CLUSTER is required for Atlas');
    }
    return `mongodb+srv://${MONGODB_USERNAME}:${MONGODB_PASSWORD}@${MONGODB_CLUSTER}.${MONGODB_HOST}.mongodb.net/${dbName}?retryWrites=true&w=majority`;
  } else if (MONGODB === 'compass') {
    if (!MONGODB_AUTH_MECH) {
      throw new Error('MONGODB_AUTH_MECH is required for Compass');
    }
    return `mongodb://${MONGODB_USERNAME}:${MONGODB_PASSWORD}@${MONGODB_HOST}/${dbName}?authMechanism=${MONGODB_AUTH_MECH}&authSource=${MONGODB_AUTH_SOURCE}`;
  } else {
    throw new Error('Invalid MONGODB value in .env file');
  }
}

async function listMongoDatabaseNames(): Promise<Set<string>> {
  try {
    const connection = await getMongoBaseConnection();
    if (!connection.db) throw new Error('MongoDB connection has no db handle');
    const dbList = await connection.db.admin().listDatabases({ nameOnly: true });
    return new Set(dbList.databases.map((db) => db.name));
  } catch (error) {
    // Don't log the URI — it contains credentials.
    console.error('Error listing MongoDB databases:', error);
    return new Set();
  }
}

async function updateEnvFile(dbConnection: boolean, isRegistration: boolean) {
  try {
    const envPath = path.join(process.cwd(), '.env');
    const envContent = await fs.readFileSync(envPath);
    const envString = envContent.toString();
    const newEnvContent = envString
      .replace(/dbConnection=.*/, `dbConnection=${dbConnection}`)
      .replace(/isRegistration=.*/, `isRegistration=${isRegistration}`);
    await fs.writeFileSync(envPath, newEnvContent);
    console.log(
      `Updated .env with dbConnection=${dbConnection} and isRegistration=${isRegistration}`
    );
  } catch (error) {
    console.error('Error updating .env file:', error);
  }
}

async function mysqlDatabaseExists(dbName: string): Promise<boolean> {
  try {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(
      'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
      [dbName]
    );
    return Array.isArray(rows) && rows.length > 0;
  } catch (error) {
    console.error(`Error checking MySQL database ${dbName}:`, error);
    return false;
  }
}

async function postgresDatabaseExists(dbName: string): Promise<boolean> {
  try {
    const pool = await getPostgresPool();
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'users'
       LIMIT 1`
    );
    return rows.length > 0 && Boolean(dbName);
  } catch (error) {
    console.error(`Error checking PostgreSQL database ${dbName}:`, error);
    return false;
  }
}

export async function GET() {
  try {
    if (isMysql()) {
      const connected = await mysqlDatabaseExists(getMysqlDatabaseName());
      await updateEnvFile(connected, connected);
      return NextResponse.json({
        masterDbConnected: connected,
        userDbConnected: connected,
        pageDbConnected: connected,
        dbConnection: connected,
      });
    }

    if (isPostgres()) {
      const connected = await postgresDatabaseExists(getPostgresDatabaseName());
      await updateEnvFile(connected, connected);
      return NextResponse.json({
        masterDbConnected: connected,
        userDbConnected: connected,
        pageDbConnected: connected,
        dbConnection: connected,
      });
    }

    const { USER_DB_NAME, PAGE_DB_NAME } = getDynamicEnv();

    if (!USER_DB_NAME || !PAGE_DB_NAME) {
      throw new Error('USER_DB_NAME or PAGE_DB_NAME environment variable is not set');
    }

    // Validate config early (throws on missing vars), then reuse the shared pool
    // instead of opening three new connections on every check.
    createConnectionUri('master');
    const existing = await listMongoDatabaseNames();
    const masterDbConnected = existing.has('master');
    const userDbConnected = existing.has(USER_DB_NAME);
    const pageDbConnected = existing.has(PAGE_DB_NAME);

    const dbConnection = masterDbConnected && userDbConnected && pageDbConnected;
    const isRegistration = dbConnection;

    await updateEnvFile(dbConnection, isRegistration);

    if (dbConnection) {
      console.log('Database connection successful');
    }

    return NextResponse.json({
      masterDbConnected,
      userDbConnected,
      pageDbConnected,
      dbConnection,
    });
  } catch (error) {
    console.error('Error handling database connection check:', error);
    await updateEnvFile(false, false);
    return NextResponse.json(
      {
        error: 'Internal Server Error',
      },
      { status: 500 }
    );
  }
}
