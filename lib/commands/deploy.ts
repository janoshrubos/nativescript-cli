import { ANDROID_RELEASE_BUILD_ERROR_MESSAGE } from "../constants";
import { ValidatePlatformCommandBase } from "./command-base";
import { DeployCommandHelper } from "../helpers/deploy-command-helper";

export class DeployOnDeviceCommand extends ValidatePlatformCommandBase implements ICommand {
	public allowedParameters: ICommandParameter[] = [];

	public dashedOptions = {
		watch: { type: OptionType.Boolean, default: false, hasSensitiveValue: false },
		hmr: { type: OptionType.Boolean, default: false, hasSensitiveValue: false },
	};

	constructor($platformValidationService: IPlatformValidationService,
		private $platformCommandParameter: ICommandParameter,
		$options: IOptions,
		$projectData: IProjectData,
		private $errors: IErrors,
		private $mobileHelper: Mobile.IMobileHelper,
		$platformsDataService: IPlatformsDataService,
		private $deployCommandHelper: DeployCommandHelper,
		private $androidBundleValidatorHelper: IAndroidBundleValidatorHelper,
		private $markingModeService: IMarkingModeService,
		private $migrateController: IMigrateController) {
		super($options, $platformsDataService, $platformValidationService, $projectData);
		this.$projectData.initializeProjectData();
	}

	public async execute(args: string[]): Promise<void> {
		const platform = args[0];
		if (this.$mobileHelper.isAndroidPlatform(platform)) {
			await this.$markingModeService.handleMarkingModeFullDeprecation({ projectDir: this.$projectData.projectDir, skipWarnings: true });
		}

		await this.$deployCommandHelper.deploy(platform);
	}

	public async canExecute(args: string[]): Promise<boolean> {
		const platform = args[0];
		if (!this.$options.force) {
			await this.$migrateController.validate({ projectDir: this.$projectData.projectDir, platforms: [platform] });
		}

		this.$androidBundleValidatorHelper.validateNoAab();
		if (!args || !args.length || args.length > 1) {
			return false;
		}

		if (!(await this.$platformCommandParameter.validate(platform))) {
			return false;
		}

		if (this.$mobileHelper.isAndroidPlatform(platform) && this.$options.release && (!this.$options.keyStorePath || !this.$options.keyStorePassword || !this.$options.keyStoreAlias || !this.$options.keyStoreAliasPassword)) {
			this.$errors.failWithHelp(ANDROID_RELEASE_BUILD_ERROR_MESSAGE);
		}

		const result = await super.canExecuteCommandBase(platform, { validateOptions: true });
		return result;
	}
}

$injector.registerCommand("deploy", DeployOnDeviceCommand);
