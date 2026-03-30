import { customType } from 'drizzle-orm/pg-core';

const geometryColumn = <TData extends string | null>(type: string) =>
  customType<{ data: TData; driverData: string }>({
    dataType() {
      return type;
    },
  });

export const geometryPolygon4326 = geometryColumn<string | null>('geometry(Polygon,4326)');
export const geometryPoint4326 = geometryColumn<string | null>('geometry(Point,4326)');
export const geometryGeneric4326 = geometryColumn<string>('geometry(Geometry,4326)');
