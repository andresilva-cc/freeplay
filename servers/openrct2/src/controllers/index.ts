import type { HttpRouter } from "../http/router.js";
import { DateController } from "./date.js";
import { getControllerDefinition } from "./decorators.js";
import { EvalController } from "./eval.js";
import { ParkController } from "./park.js";
import { RidesController } from "./rides.js";
import type { ControllerAction, ControllerClass, ControllerContext, ControllerDefinition } from "./types.js";

export function getControllers(): ControllerClass[] {
    return [
        DateController,
        EvalController,
        ParkController,
        RidesController
    ];
}

function invokeControllerAction(controllerDefinition: ControllerDefinition, routeHandlerName: string, context: ControllerContext) {
    const controller = new controllerDefinition.controllerClass(context) as unknown as Record<string, unknown>;
    const controllerAction = controller[routeHandlerName];

    if (typeof controllerAction !== "function") {
        throw new Error("Controller route handler is not a function: " + controllerDefinition.name + "." + routeHandlerName);
    }

    return (controllerAction as ControllerAction).call(controller, context);
}

export function registerControllers(router: HttpRouter, controllerClasses: ControllerClass[]): ControllerDefinition[] {
    const controllers = controllerClasses.map(getControllerDefinition);

    controllers.forEach(function (controller) {
        controller.routes.forEach(function (route) {
            router.registerRoute({
                method: route.method,
                path: route.fullPath,
                operationId: route.operationId,
                summary: route.summary,
                description: route.description,
                responseDescription: route.responseDescription,
                hideFromOpenApi: route.hideFromOpenApi,
                tags: [controller.name],
                controllerName: controller.name,
                handler: function (request, response) {
                    const params = request.params || {};

                    return invokeControllerAction(controller, route.handlerName, {
                        request: request,
                        response: response,
                        params: params
                    });
                }
            });
        });
    });

    return controllers;
}

export type { ControllerClass, ControllerContext, ControllerDefinition } from "./types.js";

