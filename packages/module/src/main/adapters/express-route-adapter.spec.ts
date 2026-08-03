import { Request, Response } from 'express';
import { adaptRoute } from './express-route-adapter.js';
import {
  Controller,
  HttpRequest,
  HttpResponse,
} from '../../presentation/interfaces/index.js';
import { buildSuccess } from '../../presentation/helpers/http-helper.js';
import { ServerError } from '../../presentation/errors/index.js';

class ControllerStub implements Controller {
  async handle(httpRequest: HttpRequest): Promise<HttpResponse> {
    return buildSuccess({ ok: true });
  }
}

const makeRes = (): Response => {
  const res = {} as Response;

  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);

  return res;
};

const makeSut = () => {
  const controllerStub = new ControllerStub();
  const sut = adaptRoute(controllerStub);

  return {
    sut,
    controllerStub,
  };
};

describe('ExpressRouteAdapter', () => {
  describe('When the controller resolves', () => {
    it('MUST respond with the controller status code and body', async () => {
      const { sut } = makeSut();
      const res = makeRes();

      await sut({ body: {}, params: {}, query: {} } as Request, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true });
    });
  });

  describe('When the controller throws', () => {
    it('MUST respond with a 500 server error instead of crashing', async () => {
      const { sut, controllerStub } = makeSut();
      const res = makeRes();

      jest
        .spyOn(controllerStub, 'handle')
        .mockRejectedValueOnce(new Error('boom'));

      await sut({ body: {}, params: {}, query: {} } as Request, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(new ServerError());
    });
  });
});
